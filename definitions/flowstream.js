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

Flow.on('save', function() {

	for (var key in Flow.db) {
		if (key !== 'variables') {
			var flow = Flow.db[key];
			flow.size = Buffer.byteLength(JSON.stringify(flow));
		}
	}

	if (CONF.backup) {
		PATH.fs.rename(PATH.join(DIRECTORY, DB_FILE), PATH.join(DIRECTORY, DB_FILE.replace(/\.json/, '') + '_' + (new Date()).format('yyyyMMddHHmm') + '.bk'), function() {
			PATH.fs.writeFile(PATH.join(DIRECTORY, DB_FILE), JSON.stringify(Flow.db, skip, '\t'), ERROR('FlowStream.save'));
		});
	} else
		PATH.fs.writeFile(PATH.join(DIRECTORY, DB_FILE), JSON.stringify(Flow.db, skip, '\t'), ERROR('FlowStream.save'));
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

		if (patched)
			Flow.emit('save');

		Object.keys(Flow.db).wait(function(key, next) {
			if (key === 'variables')
				next();
			else
				init(key, next);
		});

	});

});