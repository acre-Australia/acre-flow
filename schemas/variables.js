// Global variables

NEWACTION('Variables/read', {
	name: 'Read variable',
	query: 'id',
	action: function($) {
		var id = $.query.id;
		if (id) {
			var fs = Flow.db[id];
			if (fs)
				$.callback(fs.variables);
			else
				$.invalid(404);
		} else
			$.callback(Flow.db.variables);
	}
});

NEWACTION('Variables/save', {
	name: 'Save variables',
	input: 'id:String, data:Object',
	action: function($, model) {

		if (!model.data)
			model.data = {};

		if (model.id) {

			var id = model.id;
			var fs = Flow.db[id];
			if (fs) {
				fs.variables = model.data;
				Flow.emit('save', { id: id });
				Flow.instances[id].variables(fs.variables);
			} else {
				$.invalid(404);
				return;
			}

		} else {

			Flow.db.variables = model.data;
			// Only variables.json needs rewriting: the per-flow variables2 copy is
			// re-derived on load and never persisted
			MODS.flowdb.markvariables();

			for (let key in Flow.instances) {
				let instance = Flow.instances[key];
				instance.variables2(model.data);
			}
		}

		$.success();
	}
});