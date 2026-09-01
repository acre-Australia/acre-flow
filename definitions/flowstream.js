// Wiring only. All persistence lives in MODS.flowdb (modules/flowdb.js).

CONF.$customtitles = true;

PATH.mkdir(PATH.private());

// The library emits "save" with the flowstream payload (see Flow.onsave in
// total5/flow.js), so the write can be scoped to the one flowstream that changed.
// Only data.id is read here: the writer re-reads Flow.db[id] when it flushes, which
// keeps it correct across the async TRANSFORM callbacks in Streams/save.
Flow.on('save', function(data) {
	if (data && data.id)
		MODS.flowdb.markflow(data.id);
	else
		MODS.flowdb.markall();
});

Flow.on('remove', function(flow) {
	flow && flow.id && MODS.flowdb.removeflow(flow.id);
});

const INIT_TIMEOUT = 60000;

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

	// Flow.load can call back twice when a worker crashes and auto-restarts (each
	// init_worker reuses the same callback), so guard it either way
	var done = false;
	var timeout = null;

	var finish = function(reason) {

		if (done)
			return;

		done = true;
		timeout && clearTimeout(timeout);
		timeout = null;

		if (reason)
			console.error('FlowStream "' + (flow.name || id) + '" (' + id + ') ' + reason + ' - continuing with the remaining FlowStreams.');

		next();
	};

	timeout = setTimeout(finish, INIT_TIMEOUT, 'did not become ready within ' + (INIT_TIMEOUT / 1000) + 's');

	Flow.load(flow, function(err) {
		finish(err ? ('failed to load: ' + err) : null);
	});
}

ON('init', function() {
	MODS.flowdb.load(function() {
		Object.keys(Flow.db).wait(function(key, next) {
			if (key === 'variables')
				next();
			else
				init(key, next);
		}, function() {

			// Flow.instances[id] is what +SOCKET /flows/{id}/ resolves against, so anything
			// missing here is a flowstream the designer cannot open - it will connect and be
			// disconnected in a loop. Say so once at boot instead of leaving it to be found
			// by opening each one in the UI.
			var missing = [];

			for (var key in Flow.db) {
				if (key !== 'variables' && !Flow.instances[key])
					missing.push(key + ' (' + (Flow.db[key].name || 'unnamed') + ')');
			}

			if (missing.length) {
				console.error('FlowStream: ' + missing.length + ' FlowStream(s) have no running instance and cannot be opened in the designer:');
				for (var m of missing)
					console.error('  - ' + m);
			}

		});
	});
});
