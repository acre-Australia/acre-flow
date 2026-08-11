// Per-FlowStream backup / restore / import.
//
// Storage lives in MODS.flowdb (backup/<id>/*.bk). Export is not here: the designer
// already exports over the flow websocket (TYPE: 'export' -> flow.export2()).

// Fields taken from an incoming payload. Everything else - id, name, icon, color,
// proxypath, dtcreated, memory - is kept from the flowstream being restored into.
//
// This is an allowlist rather than a denylist on purpose. A payload can otherwise
// carry `sandbox`, `import` or `initscript`, which init_current() in
// total5/flow-flowstream.js will require() / new Function() inside the worker.
// Clipboard/import does not strip those today.
function applystate($, id, payload, callback) {

	var current = Flow.db[id];
	if (!current || id === 'variables') {
		$.invalid(404);
		return;
	}

	var next = CLONE(current);

	next.design = payload.design && payload.design.constructor === Object ? payload.design : {};
	next.variables = payload.variables && payload.variables.constructor === Object ? payload.variables : {};
	next.sources = payload.sources && payload.sources.constructor === Object ? payload.sources : {};

	// Re-hydrates component sources that were stripped as derived data on write, so a
	// snapshot taken after the dedupe still resolves every node
	next.components = MODS.flowdb.mergedefaults(payload.components);

	next.dtupdated = NOW;

	// Re-derive the runtime fields exactly as definitions/flowstream.js init() does
	next.variables2 = Flow.db.variables || {};
	next.directory = CONF.directory || PATH.root('/flowstream/');
	next.env = PREF.env || 'dev';
	next.sandbox = CONF.flowstream_sandbox == true;
	next.asfiles = CONF.flowstream_asfiles === true;
	next.worker = CONF.flowstream_worker;

	// controllers/api.js checkmessage() only guards designer "save" messages, so a
	// server-side restore has to check the node limit itself (as Clipboard/import does)
	var err = MODS.limits.checknodes(next.design);
	if (err) {
		$.invalid(err);
		return;
	}

	// FP.rewrite does not apply TMS sources - only a worker restart picks those up
	var restart = JSON.stringify(next.sources) !== JSON.stringify(current.sources || {});

	// No automatic snapshot of the outgoing state - the backup list only ever contains
	// backups the user asked for. A restore is therefore NOT undoable: the previous
	// state is gone unless an earlier snapshot happens to cover it.
	Flow.db[id] = next;

	var done = function() {

		// Order matters: instance.reload() merges into the worker's $schema, and
		// instance.restart() respawns FROM $schema. Restarting first would bring
		// back the pre-restore state.
		if (restart)
			Flow.restart(id);

		// Let flowdb write the file. Writing it here would race the worker's own
		// debounced export2() flush. Same ordering as Streams/save.
		Flow.emit('save', { id: id });

		callback();
	};

	// reload() returns false when nothing is running (e.g. a paused flowstream)
	if (Flow.instances[id]) {
		Flow.reload(next);
		done();
	} else
		Flow.load(next, done);
}

NEWACTION('Backup/list', {
	name: 'List FlowStream backups',
	params: '*id:String',
	action: function($) {

		var id = $.params.id;
		if (!Flow.db[id] || id === 'variables') {
			$.invalid(404);
			return;
		}

		MODS.flowdb.listbackups(id, function(err, items) {
			$.callback(items || []);
		});
	}
});

NEWACTION('Backup/create', {
	name: 'Create a FlowStream backup',
	input: '*id:String, label:String',
	action: function($, model) {

		var item = Flow.db[model.id];
		if (!item || model.id === 'variables') {
			$.invalid(404);
			return;
		}

		MODS.flowdb.snapshot(model.id, model.label, function(err, name) {

			if (err) {
				$.invalid('@(The backup could not be created)');
				return;
			}

			$.audit(item.name + ' / ' + name);
			$.callback({ success: true, value: name });
		});
	}
});

NEWACTION('Backup/restore', {
	name: 'Restore a FlowStream from a backup',
	permissions: 'remove',
	input: '*id:String, *name:String',
	action: function($, model) {

		var item = Flow.db[model.id];
		if (!item || model.id === 'variables') {
			$.invalid(404);
			return;
		}

		MODS.flowdb.readbackup(model.id, model.name, function(err, payload) {

			if (err) {
				$.invalid(err === 'invalid' ? '@(Invalid backup)' : 404);
				return;
			}

			applystate($, model.id, payload, function() {
				$.audit(item.name + ' / ' + model.name);
				$.success();
			});
		});
	}
});

NEWACTION('Backup/remove', {
	name: 'Remove a FlowStream backup',
	permissions: 'remove',
	input: '*id:String, *name:String',
	action: function($, model) {

		var item = Flow.db[model.id];
		if (!item || model.id === 'variables') {
			$.invalid(404);
			return;
		}

		MODS.flowdb.removebackup(model.id, model.name, function(err) {

			if (err) {
				$.invalid(err === 'invalid' ? '@(Invalid backup)' : 404);
				return;
			}

			$.audit(item.name + ' / ' + model.name);
			$.success();
		});
	}
});

NEWACTION('Backup/import', {
	name: 'Import a FlowStream state from a file',
	permissions: 'remove',
	input: '*id:String, *data:String',
	action: function($, model) {

		var item = Flow.db[model.id];
		if (!item || model.id === 'variables') {
			$.invalid(404);
			return;
		}

		var payload = model.data.parseJSON(true);
		if (!payload || payload.constructor !== Object || !payload.design || !payload.components) {
			$.invalid('@(Invalid data)');
			return;
		}

		applystate($, model.id, payload, function() {
			$.audit(item.name);
			$.success();
		});
	}
});
