exports.install = function() {
	ROUTE('+GET /', index);
	ROUTE('+GET /designer/');
	ROUTE('+GET /open/{reference}/', openflow);
	ROUTE('GET /sso/', sso);
	ROUTE('POST /sso/', sso);
	ROUTE('-GET /', login);
};

function appbasepath() {
	var base = CONF.$root || '';

	if (!base || base === '/')
		return '';

	if (base[0] !== '/')
		base = '/' + base;

	if (base[base.length - 1] === '/')
		base = base.substring(0, base.length - 1);

	return base;
}

function appurl(path) {
	var base = appbasepath();

	if (!path || path === '/')
		return base || '/';

	if (path[0] !== '/')
		path = '/' + path;

	return (base + path).replace(/\/+/g, '/');
}

function index($) {

	if ($.user.openplatform && !$.user.iframe && $.query.openplatform) {
		$.cookie(CONF.op_cookie, $.query.openplatform, NOW.add('12 hours'));
		$.redirect($.url);
		return;
	}

	let plugins = [];
	let hostname = $.hostname();

	if (CONF.url !== hostname)
		CONF.url = hostname;

	for (let key in F.plugins) {
		let item = F.plugins[key];
		if (!item.visible || item.visible($.user)) {
			let obj = {};
			obj.id = item.id;
			obj.position = item.position;
			obj.name = TRANSLATE($.user.language || '', item.name);
			obj.icon = item.icon;
			obj.import = item.import;
			obj.routes = item.routes;
			obj.hidden = item.hidden;
			plugins.push(obj);
		}
	}

	$.view('index', plugins);
}

function sso($) {
	// Accept token from: Authorization header > POST body > query string
	var token = null;

	var authHeader = $.headers['authorization'] || $.headers['Authorization'];
	if (authHeader && authHeader.substring(0, 7).toLowerCase() === 'bearer ')
		token = authHeader.substring(7).trim();

	if (!token && $.body && $.body.token)
		token = $.body.token;

	if (!token && $.query.token)
		token = $.query.token;

	if (!token) {
		$.invalid(401);
		return;
	}

	if (!CONF.jwt_secret) {
		$.invalid(500);
		return;
	}

	// Verify JWT signature: header.payload.signature (HS256)
	var parts = token.split('.');
	if (parts.length !== 3) {
		$.invalid(401);
		return;
	}

	var crypto = require('crypto');
	var expected = crypto.createHmac('sha256', CONF.jwt_secret).update(parts[0] + '.' + parts[1]).digest('base64url');
	if (expected !== parts[2]) {
		$.invalid(401);
		return;
	}

	var payload;
	try {
		payload = Buffer.from(parts[1], 'base64url').toString('utf8').parseJSON(true);
	} catch (e) {
		$.invalid(401);
		return;
	}

	if (!payload || (payload.exp && payload.exp < (Date.now() / 1000))) {
		$.invalid(401);
		return;
	}

	// Issue a FlowStream session cookie and redirect to the app
	var session = {};
	session.id = PREF.user.id;
	session.expire = NOW.add('1 month');
	session.isFullEngineer = payload.roles && payload.roles.includes('FullEngineer');
	session.sa = false;
	session.sso = true;
	session.permissions = [
		...(payload.permissions instanceof Array ? payload.permissions : []),
		'create',
		'remove'
	];
	$.cookie(CONF.cookie, ENCRYPTREQ($, session, CONF.cookie_secret), '1 month');

	var redirect = $.query.redirect || appurl('/');

	// Allow redirect from POST body too
	if ($.body && $.body.redirect)
		redirect = $.body.redirect;

	// Only allow relative redirects to prevent open redirect attacks
	if (redirect[0] !== '/')
		redirect = appurl('/');

	var base = appbasepath();
	if (base && redirect.substring(0, base.length) !== base)
		redirect = appurl(redirect);

	$.redirect(redirect);
}

function openflow($) {
	var ref = $.params.reference;
	var db = Flow.db;
	for (var key in db) {
		if (key !== 'variables' && db[key].reference === ref) {
			$.redirect(appurl('/#' + db[key].id));
			return;
		}
	}
	$.invalid(404);
}

function login($) {
	if (CONF.op_reqtoken && CONF.op_restoken) {
		if ($.query.login && CONF.openplatform)
			$.redirect(CONF.openplatform);
		else
			$.fallback(401);
	} else
		$.view('login');
}