const DB_FILE = 'database.json';
const DIRECTORY = CONF.directory || PATH.root('flowstream');
const DEFAULT_COMPONENTS_FILE = PATH.root('defaultComponents.json');

CONF.$customtitles = true;

PATH.mkdir(DIRECTORY);
PATH.mkdir(PATH.private());

function skip(key, value) {
	return key === 'unixsocket' || key === 'env' ? undefined : value;
}

function loaddefaultcomponents() {
	try {
		var body = F.Fs.readFileSync(DEFAULT_COMPONENTS_FILE, 'utf8');
		var parsed = body ? body.toString('utf8').parseJSON(true) : null;
		if (parsed && parsed.components && parsed.components.constructor === Object)
			return parsed.components;
	} catch (e) {
		F.error('Failed to load default components from ' + DEFAULT_COMPONENTS_FILE, e);
	}
	return {};
}

function patchflowcomponents(db, defaults) {
	if (!defaults || defaults.constructor !== Object)
		return 0;

	var patched = 0;

	for (var key in db) {
		if (key === 'variables')
			continue;

		var flow = db[key];
		if (!flow || !flow.components || flow.components.constructor !== Object)
			continue;

		var changed = false;

		for (var componentid in defaults) {
			if (flow.components[componentid] !== defaults[componentid]) {
				flow.components[componentid] = defaults[componentid];
				changed = true;
			}
		}

		if (changed) {
			patched++;
			flow.dtupdated = NOW;
		}
	}

	return patched;
}

var SAVE_RUNNING = false;
var SAVE_PENDING = false;

function flowdb_write(callback) {

	// Snapshot the db synchronously so nothing mutates it mid-serialize
	for (var key in Flow.db) {
		if (key !== 'variables') {
			var flow = Flow.db[key];
			flow.size = Buffer.byteLength(JSON.stringify(flow));
		}
	}

	var body = JSON.stringify(Flow.db, skip, '\t');
	var dest = PATH.join(DIRECTORY, DB_FILE);
	var tmp = dest + '.tmp';

	// Optional backup of the current (still-intact) file before replacing it
	var backup = function(next) {
		if (!CONF.backup)
			return next();
		var bk = PATH.join(DIRECTORY, DB_FILE.replace(/\.json/, '') + '_' + (new Date()).format('yyyyMMddHHmm') + '.bk');
		PATH.fs.copyFile(dest, bk, function() {
			// Ignore copy errors (e.g. first-ever save, no file yet) — must not block the write
			next();
		});
	};

	backup(function() {
		// Write to a temp file first, then atomically rename over the real file.
		// A concurrent reader / the next boot always sees either the old or the
		// new *complete* file — never a truncated or half-written one.
		PATH.fs.writeFile(tmp, body, function(err) {
			if (err) {
				ERROR('FlowStream.save')(err);
				return callback();
			}
			PATH.fs.rename(tmp, dest, function(err) {
				err && ERROR('FlowStream.save')(err);
				callback();
			});
		});
	});
}

Flow.on('save', function() {

	// Serialize: only one write may be in flight at a time. Overlapping
	// emit('save') calls collapse into a single follow-up write.
	if (SAVE_RUNNING) {
		SAVE_PENDING = true;
		return;
	}

	SAVE_RUNNING = true;

	(function run() {
		SAVE_PENDING = false;
		flowdb_write(function() {
			if (SAVE_PENDING)
				run();
			else
				SAVE_RUNNING = false;
		});
	})();
});

function init(id, next) {

	var flow = Flow.db[id];

	flow.variables2 = Flow.db.variables || {};
	flow.directory = CONF.directory || PATH.root('/flowstream/');
	flow.sandbox = CONF.flowstream_sandbox == true;
	flow.env = PREF.env || 'dev';

	if (!flow.memory)
		flow.memory = CONF.flowstream_memory || 0;

	flow.asfiles = CONF.flowstream_asfiles === true;
	flow.worker = CONF.flowstream_worker;

	Flow.load(flow, function(err, instance) {
		next();
	});
}

ON('init', function() {

	PATH.fs.readFile(PATH.join(DIRECTORY, DB_FILE), function(err, data) {

		Flow.db = data ? data.toString('utf8').parseJSON(true) : {};
		var defaults = loaddefaultcomponents();
		var patched = patchflowcomponents(Flow.db, defaults);

		if (!Flow.db.variables)
			Flow.db.variables = {};

		Object.keys(Flow.db).wait(function(key, next) {
			if (key === 'variables')
				next();
			else
				init(key, next);
		});

	});

});