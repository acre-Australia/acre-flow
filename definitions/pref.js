// MEMORIZE() below cannot survive a corrupt state file. It does `data = readFileSync(...).parseJSON(true)`,
// assigning the result straight over its own `{}` default, and String.parseJSON swallows the parse error
// and returns undefined - so a truncated or zero-length memorize_preferences.json makes its very next line
// (`data.save = ...`) throw "Cannot set properties of undefined (setting 'save')" and the app never boots.
// Such a file is easy to produce on a controller: PREF.save() is a debounced, non-atomic fs.writeFile, so a
// power cut or a full disk mid-write leaves a half-written one behind.
//
// Move a corrupt file aside - kept as .corrupt for diagnosis - and let MEMORIZE recreate it. Preferences
// reset to defaults, which beats a boot loop.
(function() {

	let filename = F.path.databases('memorize_preferences.json');
	let raw;

	try {
		raw = F.Fs.readFileSync(filename, 'utf8');
	} catch {
		// No file yet: the normal first-boot case, MEMORIZE creates it.
		return;
	}

	// Same parse MEMORIZE performs, so this accepts exactly what MEMORIZE can use. An array parses
	// fine but would give PREF no usable keys, so it counts as corrupt too.
	let parsed = raw.parseJSON(true);
	if (parsed && typeof(parsed) === 'object' && !Array.isArray(parsed))
		return;

	let backup = filename + '.corrupt';

	try {
		F.Fs.renameSync(filename, backup);
		console.log('pref: unreadable ' + filename + ' moved to ' + backup + ', preferences reset to defaults');
	} catch (e) {
		// Rename failed (read-only filesystem, no space): unlink instead, MEMORIZE still needs a clean start.
		try {
			F.Fs.unlinkSync(filename);
			console.log('pref: unreadable ' + filename + ' removed, preferences reset to defaults (' + e.message + ')');
		} catch (err) {
			console.log('pref: unreadable ' + filename + ' could not be cleared, MEMORIZE will fail (' + err.message + ')');
		}
	}

})();

global.PREF = MEMORIZE('preferences');

(function() {
	for (let key in F.plugins) {
		let item = F.plugins[key];
		if (item.config) {
			for (let m of item.config) {
				if (CONF[m.id] == null)
					CONF[m.id] = m.value;
			}
		}
	}
})();

ON('ready', function() {

	EMIT('init');

	// Due to plugins
	EMIT('reload');

});