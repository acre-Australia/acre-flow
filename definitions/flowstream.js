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
	MODS.flowdb.load(function() {
		Object.keys(Flow.db).wait(function(key, next) {
			if (key === 'variables')
				next();
			else
				init(key, next);
		});
	});
});
