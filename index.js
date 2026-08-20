// ===================================================
// Total.js v5 start script
// https://www.totaljs.com
// ===================================================

require('dotenv').config();
require('total5');

const options = {};

// Allow CI/CD to inject sensitive values without committing secrets.
const secureConfig = {};

if (process.env.JWT_SECRET)
	secureConfig.jwt_secret = process.env.JWT_SECRET;

if (process.env.COOKIE_SECRET)
	secureConfig.cookie_secret = process.env.COOKIE_SECRET;

if (process.env.COOKIE_NAME)
	secureConfig.cookie = process.env.COOKIE_NAME;

if (process.env.COMPONENTS)
	secureConfig.components = process.env.COMPONENTS;

// Build versions injected by CI/CD, rendered into the designer (see views/designer.html).
if (process.env.ACREFLOW_COMMIT_HASH)
	secureConfig.acreflow_commit_hash = process.env.ACREFLOW_COMMIT_HASH;

if (process.env.ACREFLOW_COMPONENTS_COMMIT_HASH)
	secureConfig.acreflow_components_commit_hash = process.env.ACREFLOW_COMPONENTS_COMMIT_HASH;

if (Object.keys(secureConfig).length)
	options.config = secureConfig;

// options.ip = '127.0.0.1';
// options.port = parseInt(process.argv[2]);
// options.unixsocket = PATH.join(F.tmpdir, 'app_name.socket');
// options.unixsocket777 = true;
// options.config = { name: 'Total.js' };
// options.sleep = 3000;
// options.inspector = 9229;
// options.watch = ['private'];
// options.livereload = 'https://yourhostname';
// options.edit = 'wss://www.yourcodeinstance.com/?id=projectname'

options.watcher = process.argv.includes('--watcher');
options.release = process.argv.includes('--release');

// Service mode:
options.servicemode = process.argv.includes('--service') || process.argv.includes('--servicemode');
// options.servicemode = 'definitions,modules,config';

// Cluster:
// options.tz = 'utc';
// options.cluster = 'auto';
// options.limit = 10; // max 10. threads (works only with "auto" scaling)

F.run(options);