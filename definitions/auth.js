var BLACKLIST = {};

AUTH(function($) {
	$.success({ sa: true });
});

ON('init', function() {

	OpenPlatform.permissions.push({ name: 'Create Flows', value: 'create' });
	OpenPlatform.permissions.push({ name: 'Remove Flows', value: 'remove' });

	for (var key in F.plugins) {
		var item = F.plugins[key];
		if (item.permissions)
			OpenPlatform.permissions.push.apply(OpenPlatform.permissions, item.permissions);
	}

	if (!PREF.user) {
		var password = GUID(10);
		PREF.set('user', { id: UID(), login: GUID(10), password: password.sha256(CONF.cookie_secret), raw: password });
	}

	CONF.op_cookie = CONF.cookie;
});

ON('service', function(counter) {
	if (counter % 15 === 0)
		BLACKLIST = {};
});