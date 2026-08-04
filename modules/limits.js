// Configurable capacity limits
// - CONF.flowstream_maxcount : max number of FlowStreams that can be created
// - CONF.flowstream_maxnodes : max number of components that can be added in the designer, per FlowStream
// Both are optional: 0, unset, empty or non-numeric means "unlimited".

// Keys that ride along inside a design payload but are not components
const DESIGN_META = { paused: 1, groups: 1, tabs: 1 };

function num(value) {
	// CONF values can arrive as strings (see Settings/save), so always coerce
	var n = +value;
	return n > 0 ? n : 0;
}

exports.maxflows = function() {
	return num(CONF.flowstream_maxcount);
};

exports.maxnodes = function() {
	return num(CONF.flowstream_maxnodes);
};

exports.countflows = function() {
	var count = 0;
	for (var key in Flow.db) {
		// "variables" is a shared bucket, not a FlowStream (same guard as Streams/query)
		if (key !== 'variables')
			count++;
	}
	return count;
};

exports.countnodes = function(design) {

	if (!design || design.constructor !== Object)
		return 0;

	var count = 0;
	for (var key in design) {
		if (!DESIGN_META[key])
			count++;
	}

	return count;
};

// Returns null when a new FlowStream may be created, otherwise a message
exports.canaddflow = function() {

	var max = exports.maxflows();
	if (!max || exports.countflows() < max)
		return null;

	return '@(The maximum number of FlowStreams ({0}) has been reached.)'.format(max);
};

// Returns null when the design fits the limit, otherwise a message
exports.checknodes = function(design) {

	var max = exports.maxnodes();
	if (!max)
		return null;

	var count = exports.countnodes(design);
	if (count <= max)
		return null;

	return '@(A FlowStream can contain a maximum of {0} components ({1} used).)'.format(max, count);
};
