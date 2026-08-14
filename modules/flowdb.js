// FlowStream persistence
//
// Storage layout under CONF.directory:
//
//   flows/<flowstreamid>.json          one flowstream per file
//   variables.json                     global (shared) variables
//   backup/<flowstreamid>/*.bk         per-flow backups, capped at CONF.backup_keep
//   <flowstreamid>/                    unrelated: existing sandbox/node_modules dir
//   database.json                      legacy monolith, migrated + renamed on first boot
//
// Two things this buys over the old single database.json:
//
//   1. A save rewrites only the flowstream that changed. The whole DB used to be
//      re-serialized on every designer action (node drag, config edit), which at the
//      prod ceiling of 50 flowstreams x 250 components is a ~30 MB stringify + backup
//      copy + write on the main process, roughly every 5 seconds of editing.
//
//   2. Component sources that are byte-identical to defaultComponents.json are not
//      persisted at all. They are derived data: the defaults are re-injected on load
//      and always win, so every flowstream used to carry its own 225 KB copy of the
//      same component library.
//
// Config:
//   CONF.directory     where to store everything (default: ~/flowstream)
//   CONF.backup        keep per-flow backups before overwriting (default: falsy)
//   CONF.backup_keep   how many backups to retain per flowstream (default: 10)

const DB_FILE = 'database.json';
const DEFAULT_COMPONENTS_FILE = PATH.root('defaultComponents.json');
const BACKUP_KEEP = 10;

// Cap on manual backups per flowstream (CONF.backup_manual_max, 0 = unlimited). Unlike
// CONF.backup_keep this does NOT prune - reaching it blocks Backup/create instead, so a
// deliberate snapshot is never silently deleted to make room.
const MANUAL_MAX = 10;

// Manual (user-triggered) snapshots are prefixed so prune() can leave them alone: they
// are deliberate, so nothing auto-deletes them. Automatic backups keep the old
// <id>_yyyyMMddHHmm.bk naming and are still capped by CONF.backup_keep.
const MANUAL_PREFIX = 'manual_';

// Filenames arrive from the client (Backup/restore, Backup/remove). Anything outside
// this shape - or that escapes the flowstream's own backup directory - is rejected.
const REG_BACKUP = /^[A-Za-z0-9_.-]+\.bk$/;
const REG_LABEL = /[^A-Za-z0-9-]/g;

// Coalesces bursts of dirty marks. The library already debounces flow.save() by 5s
// per flowstream, this just merges the marks that land in the same tick.
const DEBOUNCE = 750;

// Derived at load time from CONF (see definitions/flowstream.js init), or an internal
// runtime detail. Never persisted. Note "size" is intentionally not here: it is
// recomputed on every write but Streams/query reads it straight after boot.
const RUNTIME = { unixsocket: 1, env: 1, variables2: 1, directory: 1 };

var DEFAULTS = null;

function directory() {
	return CONF.directory || PATH.root('flowstream');
}

function flowsdir() {
	return PATH.join(directory(), 'flows');
}

function backupdir() {
	return PATH.join(directory(), 'backup');
}

function varsfile() {
	return PATH.join(directory(), 'variables.json');
}

function flowfile(id) {
	return PATH.join(flowsdir(), id + '.json');
}

// Shared, cached, treat as read-only. Use mergedefaults() for anything mutable.
exports.loaddefaults = function() {

	if (DEFAULTS)
		return DEFAULTS;

	try {
		var body = F.Fs.readFileSync(DEFAULT_COMPONENTS_FILE, 'utf8');
		var parsed = body ? body.toString('utf8').parseJSON(true) : null;
		DEFAULTS = parsed && parsed.components && parsed.components.constructor === Object ? parsed.components : {};
	} catch (e) {
		DEFAULTS = {};
		F.error('Failed to load default components from ' + DEFAULT_COMPONENTS_FILE, e);
	}

	return DEFAULTS;
};

// Fresh components object: the stored (custom / imported) ones plus the defaults.
// Defaults win, which is exactly what the old boot-time patchflowcomponents() did.
exports.mergedefaults = function(stored) {
	return Object.assign({}, stored && stored.constructor === Object ? stored : null, exports.loaddefaults());
};

// The inverse: drop everything the defaults will re-supply on the next load
function stripdefaults(components) {

	if (!components || components.constructor !== Object)
		return {};

	var defaults = exports.loaddefaults();
	var out = {};

	for (var key in components) {
		if (defaults[key] === undefined || components[key] !== defaults[key])
			out[key] = components[key];
	}

	return out;
}

function serialize(flow) {

	// Same value Streams/query reports, so keep measuring the whole flowstream
	// (components included) rather than its stripped on-disk form
	flow.size = Buffer.byteLength(JSON.stringify(flow));

	var data = {};

	for (var key in flow) {
		if (!RUNTIME[key])
			data[key] = flow[key];
	}

	data.components = stripdefaults(flow.components);

	return JSON.stringify(data, null, '\t');
}

// Write to a temp file first, then atomically rename over the real one. A concurrent
// reader / the next boot always sees either the old or the new *complete* file, never
// a truncated one. (Original fix: #PG-1888.)
function atomic(dest, body, callback) {
	var tmp = dest + '.tmp';
	F.Fs.writeFile(tmp, body, function(err) {
		if (err) {
			ERROR('FlowDB.save')(err);
			callback();
			return;
		}
		F.Fs.rename(tmp, dest, function(err) {
			err && ERROR('FlowDB.save')(err);
			callback();
		});
	});
}

function prune(dir, callback) {

	var keep = +(CONF.backup_keep || BACKUP_KEEP);
	if (!(keep > 0))
		return callback();

	F.Fs.readdir(dir, function(err, files) {

		if (err || !files)
			return callback();

		// Names are <id>_yyyyMMddHHmm.bk so a lexicographic sort is chronological.
		// Manual snapshots are exempt - the user asked for those explicitly.
		var arr = files.filter(n => n.endsWith('.bk') && !n.startsWith(MANUAL_PREFIX)).sort();
		if (arr.length <= keep)
			return callback();

		arr.slice(0, arr.length - keep).wait(function(name, next) {
			F.Fs.unlink(PATH.join(dir, name), () => next());
		}, callback);

	});
}

function backup(id, src, callback) {

	if (!CONF.backup)
		return callback();

	var dir = PATH.join(backupdir(), id);

	F.Fs.mkdir(dir, { recursive: true }, function() {
		var bk = PATH.join(dir, id + '_' + (new Date()).format('yyyyMMddHHmm') + '.bk');
		// Ignore copy errors (first-ever save: no file yet), must not block the write
		F.Fs.copyFile(src, bk, function() {
			prune(dir, callback);
		});
	});
}

function writeflow(id, callback) {

	var flow = Flow.db[id];

	// Removed while the write was queued
	if (!flow)
		return callback();

	var body;

	try {
		body = serialize(flow);
	} catch (e) {
		ERROR('FlowDB.save')(e);
		return callback();
	}

	var dest = flowfile(id);

	backup(id, dest, function() {
		atomic(dest, body, callback);
	});
}

function writevariables(callback) {
	atomic(varsfile(), JSON.stringify(Flow.db.variables || {}, null, '\t'), callback);
}

var pending = {};
var pendingvars = false;
var writing = false;
var timeout = null;

function schedule() {
	if (!timeout && !writing)
		timeout = setTimeout(flush, DEBOUNCE);
}

function flush() {

	timeout = null;

	// A flush is already in flight, it reschedules itself when it finds new marks
	if (writing)
		return;

	var ids = Object.keys(pending);
	var vars = pendingvars;

	pending = {};
	pendingvars = false;

	if (!ids.length && !vars)
		return;

	writing = true;

	var done = function() {
		writing = false;
		if (pendingvars || Object.keys(pending).length)
			schedule();
	};

	ids.wait(writeflow, function() {
		vars ? writevariables(done) : done();
	});
}

exports.markflow = function(id) {
	if (id) {
		pending[id] = true;
		schedule();
	}
};

exports.markvariables = function() {
	pendingvars = true;
	schedule();
};

// Fallback for a save signal that does not name a flowstream
exports.markall = function() {
	for (var key in Flow.db) {
		if (key !== 'variables')
			pending[key] = true;
	}
	pendingvars = true;
	schedule();
};

exports.removeflow = function(id) {
	delete pending[id];
	F.Fs.unlink(flowfile(id), NOOP);
	F.Fs.rm(PATH.join(backupdir(), id), { recursive: true, force: true }, NOOP);
};

// --- Manual backups -------------------------------------------------------------
// Everything below is driven by schemas/backup.js. The private helpers above
// (backupdir/serialize/atomic/prune) stay private on purpose; these are the only
// supported entry points.

// Resolves <backupdir>/<id>/<name> and refuses anything that escapes it. Returns
// null when the name is not a plain .bk filename or the path breaks out.
function backupfile(id, name) {

	if (!id || !name || !REG_BACKUP.test(name))
		return null;

	var dir = PATH.join(backupdir(), id);
	var filename = PATH.join(dir, name);

	// Belt and braces: REG_BACKUP already forbids "/", but resolve and re-check so a
	// future loosening of the regex cannot turn into arbitrary file access
	if (F.Path.resolve(filename).indexOf(F.Path.resolve(dir) + F.Path.sep) !== 0)
		return null;

	return filename;
}

// Snapshots the flowstream's LIVE state, pulled from the running worker rather than
// from Flow.db[id] or flows/<id>.json - both of those lag the designer by the worker's
// 5s save debounce plus this module's own DEBOUNCE.
exports.snapshot = function(id, label, callback) {

	var flow = Flow.db[id];
	if (!flow || id === 'variables')
		return callback('404');

	var instance = Flow.instances[id];

	// Nothing running (e.g. a paused flowstream): the parent's copy is all there is
	if (!instance)
		return writesnapshot(id, flow, label, callback);

	// The design lives inside the worker. Flow.db[id] is only refreshed when the worker
	// flushes its own 5s save debounce (stream/save in total5/flow-flowstream.js), so a
	// node added seconds ago is not in Flow.db yet. Ask the instance for its live state.
	var done = false;

	var finish = function(data) {
		if (done)
			return;
		done = true;
		writesnapshot(id, data, label, callback);
	};

	// If the worker never answers, still write what the parent knows rather than
	// leaving the request hanging - instance.export() has no timeout of its own
	var timeout = setTimeout(() => finish(flow), 5000);

	instance.export(function(err, data) {
		clearTimeout(timeout);
		// export2() omits variables2/directory/unixsocket, so layer it over the parent
		// copy: exported values win, nothing already known is lost
		finish(data && data.constructor === Object ? Object.assign({}, flow, data) : flow);
	});
};

function writesnapshot(id, flow, label, callback) {

	var body;

	try {
		body = serialize(flow);
	} catch (e) {
		ERROR('FlowDB.snapshot')(e);
		return callback('serialize');
	}

	label = (label || '').replace(REG_LABEL, '').substring(0, 40);

	var name = MANUAL_PREFIX + (new Date()).format('yyyyMMddHHmmss') + (label ? ('__' + label) : '') + '.bk';
	var dir = PATH.join(backupdir(), id);

	F.Fs.mkdir(dir, { recursive: true }, function(err) {

		if (err) {
			ERROR('FlowDB.snapshot')(err);
			return callback('mkdir');
		}

		// Reuses the tmp+rename write, so a reader never sees a partial snapshot.
		// Deliberately does not prune - manual snapshots are never auto-deleted.
		atomic(PATH.join(dir, name), body, () => callback(null, name));
	});
}

// Dates come from stat.mtime rather than the filename, so legacy automatic
// <id>_yyyyMMddHHmm.bk files list correctly too. Newest first.
exports.listbackups = function(id, callback) {

	var dir = PATH.join(backupdir(), id);

	F.Fs.readdir(dir, function(err, files) {

		// No directory yet just means no backups
		if (err || !files)
			return callback(null, []);

		var arr = [];

		files.filter(n => n.endsWith('.bk')).wait(function(name, next) {

			var filename = PATH.join(dir, name);

			F.Fs.stat(filename, function(err, stat) {

				if (err || !stat.isFile())
					return next();

				var item = {};
				item.name = name;
				item.size = stat.size;
				item.dtcreated = stat.mtime;
				item.manual = name.startsWith(MANUAL_PREFIX);

				var index = name.indexOf('__');
				item.label = index === -1 ? '' : name.substring(index + 2, name.length - 3);

				// Node count needs the payload. These are small (components are
				// stripped) and this only runs when the user opens the dialog.
				F.Fs.readFile(filename, 'utf8', function(err, body) {
					var flow = body ? body.parseJSON(true) : null;
					item.nodes = flow ? MODS.limits.countnodes(flow.design) : 0;
					item.invalid = !flow;
					arr.push(item);
					next();
				});
			});

		}, function() {
			// Newest first. Explicit comparator: quicksort('dtcreated', false) does not
			// order Date values descending.
			arr.sort((a, b) => b.dtcreated - a.dtcreated);
			callback(null, arr);
		});

	});
};

// Resolved manual-backup cap. 0 means unlimited; unset falls back to MANUAL_MAX.
// CONF values arrive as strings from the config file, so always coerce.
exports.manualmax = function() {
	var max = CONF.backup_manual_max == null || CONF.backup_manual_max === '' ? MANUAL_MAX : +CONF.backup_manual_max;
	return max > 0 ? max : 0;
};

// Cheap count - just names, no file reads (listbackups parses every file to count nodes)
exports.countmanual = function(id, callback) {
	F.Fs.readdir(PATH.join(backupdir(), id), function(err, files) {
		if (err || !files)
			return callback(null, 0);
		callback(null, files.filter(n => n.endsWith('.bk') && n.startsWith(MANUAL_PREFIX)).length);
	});
};

exports.readbackup = function(id, name, callback) {

	var filename = backupfile(id, name);
	if (!filename)
		return callback('invalid');

	F.Fs.readFile(filename, 'utf8', function(err, body) {

		if (err)
			return callback('404');

		var flow = body ? body.parseJSON(true) : null;
		if (!flow || flow.constructor !== Object)
			return callback('invalid');

		callback(null, flow);
	});
};

exports.removebackup = function(id, name, callback) {

	var filename = backupfile(id, name);
	if (!filename)
		return callback('invalid');

	F.Fs.unlink(filename, function(err) {
		callback(err ? '404' : null);
	});
};

// One-shot split of the legacy monolith. Idempotent: skipped once flows/ has content.
function migrate(callback) {

	var legacy = PATH.join(directory(), DB_FILE);

	F.Fs.readdir(flowsdir(), function(err, files) {

		if ((files || []).some(n => n.endsWith('.json')))
			return callback();

		F.Fs.readFile(legacy, 'utf8', function(err, body) {

			// Fresh install, nothing to migrate
			if (err || !body)
				return callback();

			var db = body.parseJSON(true);
			if (!db || db.constructor !== Object) {
				F.error('FlowDB: cannot parse ' + legacy + ', migration skipped');
				return callback();
			}

			var ids = Object.keys(db).filter(key => key !== 'variables' && db[key] && db[key].constructor === Object);

			F.Fs.writeFile(varsfile(), JSON.stringify(db.variables || {}, null, '\t'), function(err) {

				err && F.error(err);

				ids.wait(function(id, next) {

					var flow = db[id];
					if (!flow.id)
						flow.id = id;

					var b;

					try {
						b = serialize(flow);
					} catch (e) {
						F.error(e);
						return next();
					}

					F.Fs.writeFile(flowfile(id), b, function(err) {
						err && F.error(err);
						next();
					});

				}, function() {
					var moved = legacy + '.migrated-' + (new Date()).format('yyyyMMddHHmmss');
					F.Fs.rename(legacy, moved, function(err) {
						err && F.error(err);
						console.log('FlowDB: migrated ' + ids.length + ' flowstream(s) from database.json into flows/');
						callback();
					});
				});

			});

		});

	});
}

// defaultComponents.json is written by CI before startup, and since component sources
// are stripped from the flow files as derived data, it is load-bearing: if it is
// missing or unparseable, every design node resolves to a component that does not
// exist, the engine deletes the node from meta.flow (FP.use in total5/flowstream.js)
// and the next automatic save persists an empty design. flow.save() fires from the
// cleaner and TMS sync among ~30 sites, so this needs no user action and there is no
// useful window to intervene inside the 5s debounce.
//
// So refuse to start: nothing overwrites good data, a rolling deploy keeps the
// previous container serving, and CI surfaces the failure.
//
// Deliberately narrow. It only trips when the defaults are entirely absent, which is
// the CI-did-not-write-it case. It does not trip on a flow that carries its own
// component sources (a database.json migrated while the defaults were missing strips
// nothing), nor on a lone orphan node in an otherwise healthy flow, which the engine
// has always tolerated non-fatally.
function guard(db) {

	if (Object.keys(exports.loaddefaults()).length)
		return;

	var affected = [];

	for (var key in db) {
		if (key === 'variables')
			continue;
		var flow = db[key];
		if (MODS.limits.countnodes(flow.design) && !Object.keys(flow.components || {}).length)
			affected.push(key + ' (' + (flow.name || 'unnamed') + ')');
	}

	// Fresh install, or nothing to lose
	if (!affected.length)
		return;

	console.error('');
	console.error('!!! FATAL: ' + DEFAULT_COMPONENTS_FILE + ' is missing or empty.');
	console.error('!!! These flowstreams have a design but no component sources:');
	for (var m of affected)
		console.error('!!!   ' + m);
	console.error('!!! Starting would persist empty designs and lose them. Refusing to start.');
	console.error('!!! CI writes this file before startup - restore it and retry.');
	console.error('!!! Per-flowstream backups: ' + backupdir() + '/<flowstreamid>/');
	console.error('');

	process.exit(1);
}

// Populates Flow.db. Keeps the magic "variables" key so every existing consumer
// (Streams/query, MODS.limits.countflows, openflow) is unchanged.
exports.load = function(callback) {

	PATH.mkdir(directory());
	PATH.mkdir(flowsdir());

	if (CONF.backup)
		PATH.mkdir(backupdir());

	migrate(function() {

		var db = {};

		F.Fs.readFile(varsfile(), 'utf8', function(err, body) {

			var variables = body ? body.parseJSON(true) : null;
			db.variables = variables && variables.constructor === Object ? variables : {};

			F.Fs.readdir(flowsdir(), function(err, files) {

				var arr = (files || []).filter(n => n.endsWith('.json'));

				arr.wait(function(name, next) {

					var filename = PATH.join(flowsdir(), name);

					F.Fs.readFile(filename, 'utf8', function(err, body) {

						if (err) {
							F.error('FlowDB: cannot read ' + filename, err);
							return next();
						}

						var flow = body ? body.parseJSON(true) : null;

						// A corrupt file loses one flowstream, not the boot
						if (!flow || flow.constructor !== Object) {
							F.error('FlowDB: cannot parse ' + filename + ', flowstream skipped');
							return next();
						}

						if (!flow.id)
							flow.id = name.substring(0, name.length - 5);

						flow.components = exports.mergedefaults(flow.components);
						db[flow.id] = flow;
						next();
					});

				}, function() {
					// Before Flow.load runs, so a degraded boot cannot write
					guard(db);
					Flow.db = db;
					callback();
				});

			});

		});

	});
};
