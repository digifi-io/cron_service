'use strict';
const Promisie = require('promisie');
const fs = require('fs-extra');
const path = require('path');
const usecroncheckfile = path.resolve(__dirname, '../../../content/files/croncheck.json');
const parallel = Promisie.promisify(require('async').parallel);
const cronPath = path.resolve(__dirname, '../../../content/files/crons');
const executeProcess = require('child_process').exec;
const spawnProcess = require('child_process').spawn;
const crypto = require('crypto');

var CoreController,
	cron_lib,
	Cron,
	Asset,
	logger,
	assetController,
	pemfile,
	digest,
	appSettings,
	appenvironment,
	CoreUtilities,
	cloudUploads,
	downloadRemoteFiles,
	periodic,
	themeName;

var setCronFilePath = function (req, res, next) {
	req.localuploadpath = cronPath;
	req.body['existing-file-name'] = true;
	req.controllerData = req.controllerData || {};
	req.controllerData.encryptfiles = true;
	next();
};

/**
 * Utility function for generating a file signature
 * @param  {Object}   options Options for the function
 * @param {string} options.filePath Path to the file that the signature is for
 * @param {string} options.encoding Encoding of the file that the signature is being generated for
 * @param {string} options.file File data that is passed through to the callback function
 * @param  {Function} cb      Callback function
 */
var createFileSignatures = function (options, cb) {
	try {
		Promisie.promisify(fs.readFile)(options.filePath, options.encoding || 'utf8')
			.then(filedata => {
				let signData = new Buffer(filedata.trim()).toString('base64');
				let sign = crypto.createSign('RSA-SHA256');
				sign.update(signData);
				//pemfile is a .pem file used in generating the signature that is read at initialization and held in memory
				let signature = sign.sign(pemfile, 'hex');
				cb(null, {
					file: options.file,
					signature: signature
				});
			}, e => {
				cb(e);
			});
	}
	catch (e) {
		cb(e);
	}
};

/**
 * Creates periodic cron objects from assets
 * @param  {Object} req Express request object
 * @param {Array} req.controllerData.files An array of periodic file assets generated by the asset controller
 * @param {string} req.body.interval The interval at which the cron should be run
 * @param  {Object} res Express response object
 */
var createCrons = function (req, res, next) {
	try {
		let files = (Array.isArray(req.controllerData.files)) ? req.controllerData.files : [req.controllerData.files];
		//Tests that files are a javascript mimetype
		const jsMimeTest = function (mime) {
			return (mime === 'application/javascript' || mime === 'text/javascript' || mime === 'application/x-javascript');
		};
		let javascriptFiles = files.filter(file => jsMimeTest(file.mimetype));
		if (javascriptFiles.length) {
			//Converts asset data into an object that is compatible with downloadRemoteFiles function
			let filesForDownload = javascriptFiles.map(filedata => {
				return {
					locationtype: 'amazon',
					asset: filedata
				};
			});
			downloadRemoteFiles(filesForDownload)
				.then(() => {
					//Iterates through files returing the file and its signature
					let signatures = javascriptFiles.map(file => {
						return Promisie.promisify(createFileSignatures)({
							filePath: path.join(cronPath, file.attributes.periodicFilename),
							file: file
						});
					});
					return Promise.all(signatures);
				})
				.then(filedatas => {
					//Iterates through files finding corresponding assets and returns and array of cron mongoose schema compatible objects
					let readytocreate = filedatas.map(filedata => {
						return Promise.resolve(Asset.findOne({
							name: path.basename(filedata.file.attributes.periodicFilename, '.js').replace(/_/g, '-') + '-js'
						})).then(associatedAsset => {
							// console.log('req.body', req.body);
							return {
								title: filedata.file.attributes.periodicFilename,
								name: filedata.file.attributes.periodicFilename,
								author: (req.user && typeof req.user === 'object') ? req.user.email : 'cron',
								content: 'cron',
								asset: associatedAsset._id,
								asset_signature: filedata.signature,
								cron_interval: req.body.cron_interval || '00 00 00 * * *',
								runtime_options: JSON.parse(req.body.runtime_options || '{}'),
								theme: (typeof themeName === 'string') ? themeName : undefined
							};
						});
					});
					return Promise.all(readytocreate);
				})
				.then(crons => {
					let createdCrons = crons.map(_cron => {
						return CoreController.createModelPromisified({
							model: Cron,
							newdoc: _cron
						});
					});
					return Promise.all(createdCrons);
				})
				.then(crons => {
					//Removes temporary cron files from cron directory
					let removed = crons.map(cron => {
						return Promisie.promisify(fs.remove)(path.join(cronPath, cron.name));
					});
					return Promise.all(removed)
						.then(() => crons);
				})
				.then(crons => {
					logger.silly('created crons', crons);
					//checks if croncheck file exists and runs digest function if it is
					if (periodic.app.controller.extension.cron_service.settings.cron_check_file_enabled) {
						Promisie.promisify(digest)(null)
							.then(() => {
								return crons;
							})
							.catch(e => {
								logger.silly('Dont use crons', e);
								return crons;
							});
					}
					else {
						return crons;
					}
				})
				.then(crons => {
					next();
					// res.send({
					// 	result: 'success',
					// 	data: {
					// 		crons: crons
					// 	}
					// });
				})
				.catch(e => {
					console.log('error in catch: ', e);
					CoreController.handleDocumentQueryErrorResponse({
						err: e,
						res: res,
						req: req
					});
				});
		}
		else {
			CoreController.handleDocumentQueryErrorResponse({
				err: 'No application/javascript type files were set for upload',
				res: res,
				req: req
			});
		}
	}
	catch (e) {
		console.log('error in bottom catch: ', e);
		CoreController.handleDocumentQueryErrorResponse({
			err: e,
			res: res,
			req: req
		});
	}
};

/**
 * Middleware function that prepares update to crons active/inactive status
 * @param {Object}   req  Express request object
 * @param {Object} req.controllerData.cron Mongo cron object
 * @param {Object}   res  Express response object
 */
var set_cron_status = function (req, res, next) {
	req.body = req.controllerData.cron.toJSON();
	req.body.docid = req.controllerData.cron._id;
	req.body.active = !req.body.active;
	req.body._id = undefined;
	req.body.asset = req.controllerData.cron.asset._id;
	req.skipemptyvaluecheck = true;
	delete req.body._id;
	next();
};

var updateCronStatus = function (req, res) {
	try {
		let cronStatus = req.body.active;
		CoreController.updateModelPromisified({
				model: Cron,
				docid: req.body.docid,
				id: req.body.docid,
				updatedoc: req.body,
				originalrevision: req.controllerData.cron,
				skipemptyvaluecheck: true
			})
			.then(() => {
				let modifiedCron = [{
					id: req.controllerData.cron._id,
					status: req.body.active
				}];
				return Promisie.promisify(digest)(modifiedCron);
			})
			.then(() => {
				res.send({
					result: 'success',
					data: {
						message: `Cron ${ req.controllerData.cron._id } has ${ (cronStatus) ? 'started' : 'stopped' }`
					}
				});
			})
			.catch(e => {
				CoreController.handleDocumentQueryErrorResponse({
					err: e,
					res: res,
					req: req
				});
			});
	}
	catch (e) {
		CoreController.handleDocumentQueryErrorResponse({
			err: e,
			res: res,
			req: req
		});
	}
};

var deleteCron = function (req, res) {
	try {
		var options = {
			model: Cron,
			population: 'asset',
			docid: req.params.id
		};
		CoreController.loadModelPromisified(options)
			.then(cron => {
				return parallel({
						delete_cron: function (cb) {
							CoreController.deleteModelPromisified({
									model: Cron,
									deleteid: cron._id
								})
								.then(() => {
									cb(null, 'deleted cron');
								}, cb);
						},
						delete_asset: function (cb) {
							CoreController.deleteModelPromisified({
									model: Asset,
									deleteid: cron.asset._id
								})
								.then(() => {
									cb(null, 'deleted asset');
								}, cb);

						},
						delete_remote_file: function (cb) {
							let asset = cron.asset;
							let cloudClient = cloudUploads.cloudstorageclient();
							cloudClient.removeFile(asset.attributes.cloudcontainername, asset.attributes.cloudfilepath, cb);
						},
						delete_local_file: function (cb) {
							let filePath = path.join(cronPath, cron.asset.attributes.periodicFilename);
							Promisie.promisify(fs.stat)(filePath)
								.then(() => {
									fs.remove(filePath, cb);
								}, e => {
									logger.silly('There is not local file', e);
									cb(null, null);
								});
						}
					})
					.then(() => cron);
			})
			.then(cron => {
				let deletedCron = [{
					id: cron._id,
					status: false
				}];
				return Promisie.promisify(digest)(deletedCron);
			})
			.then(() => {
				res.send({
					result: 'success',
					data: {
						message: 'Cron was deleted and stopped'
					}
				});
			})
			.catch(e => {
				CoreController.handleDocumentQueryErrorResponse({
					err: e,
					res: res,
					req: req
				});
			});
	}
	catch (e) {
		CoreController.handleDocumentQueryErrorResponse({
			err: e,
			res: res,
			req: req
		});
	}
};

var runCron = function (req, res) {
	let cron = req.controllerData.cron.toJSON();
	let downloadOptions = [cron];
	downloadRemoteFiles(downloadOptions)
		.then(() => {
			let fnPath = path.join(cronPath, cron.asset.attributes.periodicFilename);
			require(fnPath).script(periodic)(Object.assign({}, cron.runtime_options));
			return new Promise(resolve => {
				setTimeout(function () {
					resolve();
				}, 10000);
			});
		})
		.then(() => {
			let cronMap = cron_lib.getCronMap();
			if (Object.keys(cronMap).indexOf(cron._id.toString()) === -1) {
				return Promisie.promisify(fs.remove)(path.join(cronPath, cron.asset.attributes.periodicFilename));
			}
			else {
				return true;
			}
		})
		.then(() => {
			next();
			// res.send({
			// 	result: 'success',
			// 	data: {
			// 		message: `Finished running cron ${ cron._id }`
			// 	}
			// });
		})
		.catch(e => {
			CoreController.handleDocumentQueryErrorResponse({
				err: e,
				res: res,
				req: req
			});
		});
};

/**
 * Removes temporary file from content/files/crons directory if cron is not currently active
 * @param  {Object} cron Periodic cron object
 */
var removeNonActiveCronAfterProcess = function (cron) {
	try {
		let cronMap = cron_lib.getCronMap();
		if (Object.keys(cronMap).indexOf(cron._id.toString()) === -1) {
			fs.remove(path.join(cronPath, cron.asset.attributes.periodicFilename), function () {
				logger.silly('Removed temp cron file after validate');
			});
		}
	}
	catch (e) {
		logger.warn('Could not remove temp cron file after process', e);
	}
};

/**
 * Utility function for running validate_cron script in a child process
 * @param  {string} filePath The absolute path to the file being linted
 * @return {Object} returns a new Promise
 */
var lint = function (filePath) {
	return new Promise((resolve, reject) => {
		executeProcess(`node ${ path.join(__dirname, '../scripts/validate_cron.js') } --filePath ${ filePath }`, (err, stdout, stderr) => {
			if (stdout) {
				resolve(stdout);
			}
			else {
				reject(err || stderr);
			}
		});
	});
};

/**
 * Function that runs cron file validation and sends the results of the lint
 * @param  {Object} req Express request object
 * @param {Object} req.controllerData Data that has been appended to request object is previous middleware
 * @param {Object} req.controllerData.cron Mongo cron object
 * @param  {Object} res Express response object
 */
var validateCron = function (req, res) {
	try {
		let cron = req.controllerData.cron.toJSON();
		let lintPath = path.join(cronPath, cron.asset.attributes.periodicFilename);
		Promisie.promisify(fs.stat)(lintPath)
			.then(() => {
				return true;
			}, () => {
				return downloadRemoteFiles([cron]);
			})
			.then(() => lint(lintPath))
			.then(result => {
				res.send({
					result: 'success',
					data: result
				});
				removeNonActiveCronAfterProcess(cron);
			})
			.catch(e => {
				removeNonActiveCronAfterProcess(cron);
				CoreController.handleDocumentQueryErrorResponse({
					err: e,
					res: res,
					req: req
				});
			});
	}
	catch (e) {
		CoreController.handleDocumentQueryErrorResponse({
			err: e,
			res: res,
			req: req
		});
	}
};

/**
 * Executes child process which runs cron test file using mocha assumes that the test file is in the theme lib directory
 * @param  {string} filePath An absolute file path for the cron file
 * @return {Object}          returns a new Promise
 */
var testCron = function (filePath) {
	let cron = require(filePath);
	return new Promise((resolve, reject) => {
		try {
			if (!cron.test) {
				throw new Error('Cron does not have a defined test configuration');
			}
			else {
				let argv = [path.join(__dirname, '../scripts/mocha_cron.js'), '--fileName', path.join(path.join(__dirname, `../../../content/themes/${ appSettings.theme }/lib`), cron.test.fileName), '--modulePath', filePath];
				if (cron.test.options && typeof cron.test.options === 'object') {
					argv.push('--mochaOptions', JSON.stringify(cron.test.options));
				}
				let child = spawnProcess('node', argv, {
					stdio: ['ignore', 'pipe', 'pipe'],
					cwd: path.join(__dirname, '../../../')
				});
				let result;
				let error = '';
				child.stdout.on('data', d => {
					let data = d.toString();
					try {
						if (/^\{/.test(data)) {
							let parsed = JSON.parse(data);
							if (parsed.failures && parsed.passes) {
								result = parsed;
							}
						}
					}
					catch (e) {
						return;
					}
				});
				child.stderr.on('data', e => {
					error += e.toString();
				});
				child.on('exit', () => {
					if (result) {
						resolve(result);
					}
					else {
						reject(error);
					}
				});
			}
		}
		catch (e) {
			reject(e);
		}
	});
};

/**
 * Function that runs cron test spec and responds with the passing and failing cases
 * @param  {Object} req Express request object
 * @param {Object} req.controllerData.cron Periodic cron object
 * @param  {Object} res Express response object
 */
var mochaCron = function (req, res) {
	try {
		let cron = req.controllerData.cron.toJSON();
		let testPath = path.join(cronPath, cron.asset.attributes.periodicFilename);
		Promisie.promisify(fs.stat)(testPath)
			.then(() => {
				return true;
			}, () => {
				return downloadRemoteFiles([cron]);
			})
			.then(() => testCron(testPath))
			.then(testResult => {
				try {
					let response = {
						result: 'success',
						data: {}
					};
					if (typeof testResult === 'string') {
						throw new Error(`Error from child - ${ testResult }`);
					}
					if (testResult.stats && Number(testResult.stats.failures) > 0) {
						response.data.message = JSON.stringify(testResult);
					}
					else {
						response.data.message = 'Completed test spec with no failures';
					}
					logger.info(`${ cron.asset.attributes.periodicFilename } test results`, testResult);
					res.send(response);
					removeNonActiveCronAfterProcess(cron);
				}
				catch (e) {
					return Promise.reject(e);
				}
			})
			.catch(e => {
				removeNonActiveCronAfterProcess(cron);
				CoreController.handleDocumentQueryErrorResponse({
					err: e,
					res: res,
					req: req
				});
			});
	}
	catch (e) {
		CoreController.handleDocumentQueryErrorResponse({
			err: e,
			res: res,
			req: req
		});
	}
};

const handleResponseData = function (req, res) {
	req.controllerData = req.controllerData || {};
	delete req.controllerData.authorization_header;
	res.send((req.controllerData.useSuccessWrapper) ? {
		result: 'success',
		data: req.controllerData,
	} : req.controllerData);
};

module.exports = function (resources) {
	cron_lib = require('../lib/crons')(resources);
	digest = cron_lib.digest;
	downloadRemoteFiles = cron_lib.downloadRemoteFiles;
	appSettings = resources.settings;
	appenvironment = appSettings.application.environment;
	themeName = (resources.app.controller.extension.cron_service.settings.validate_theme === true) ? appSettings.theme : false;
	CoreController = resources.core.controller;
	CoreUtilities = resources.core.utilities;
	Cron = resources.mongoose.model('Cron');
	logger = resources.logger;
	Asset = resources.mongoose.model('Asset');
	assetController = resources.app.controller.native.asset;
	pemfile = fs.readFileSync(resources.app.controller.extension.cron_service.settings.pemfile_path, 'utf8');
	cloudUploads = resources.app.controller.extension.cloudupload.cloudupload;
	periodic = resources;
	const RAHelperController = resources.app.controller.extension.reactadmin.controller.helper;
	const oauth2authController = resources.app.controller.extension.oauth2server.auth;
	let cronSettings = {
		model_name: 'cron',
		model: Cron,
		controllerOptions: {
			model: Cron
		},
		use_admin_menu: true,
		use_plural_view_names: true,
		load_model_population: 'asset',
		load_multiple_model_population: 'asset',
		use_full_data: true,
		extname: 'periodicjs.ext.cron_service'
	};
	let override = {
		create_item: [
			oauth2authController.ensureApiAuthenticated,
			RAHelperController.handleFileUpload,
			RAHelperController.handleFileAssets,
			RAHelperController.fixCodeMirrorSubmit,
			RAHelperController.fixFlattenedSubmit,
			setCronFilePath,
			createCrons,
			(req, res, next) => {
				return res.status(200).send({
					status: 200,
					response: 'success',
					successCallback: 'func:this.props.reduxRouter.push',
					pathname: '/extension/crons',
				});
		}],
		// create_index: [cron_create_index],
		delete_item: [oauth2authController.ensureApiAuthenticated, deleteCron],
		get_index: [
			oauth2authController.ensureApiAuthenticated,
			function (req, res, next) {
				req.controllerData = req.controllerData || {};
				req.controllerData.model_query = (typeof themeName === 'string') ? {
					theme: themeName
				} : {};
				next();
			},
			CoreController.controller_load_model_with_count(cronSettings),
			CoreController.controller_load_model_with_default_limit(cronSettings),
			CoreController.controller_model_query(cronSettings),
			CoreController.controller_index(cronSettings)
		],
		update_item: [
			oauth2authController.ensureApiAuthenticated,
			function (req, res, next) {
				req.body.runtime_options = JSON.parse(req.body.runtime_options || '{}');
				next();
			},
			CoreController.save_revision,
			CoreController.controller_update(cronSettings)
		]
	};
	cronSettings.override = override;
	let cronController = CoreController.controller_routes(cronSettings);
	let asyncadminController = resources.app.controller.extension.asyncadmin;

  // cronController.router.use(oauth2authController.ensureApiAuthenticated);
	cronController.router.post('/crons/setactive/:id/:status', cronController.loadCron, set_cron_status, updateCronStatus);
	cronController.router.get('/cron/:id/validate', cronController.loadCron, validateCron);
	cronController.router.get('/cron/:id/mocha', cronController.loadCron, mochaCron);
	cronController.router.get('/cron/:id/run', cronController.loadCron, runCron, handleResponseData);
	cronController.router.get('/cron/:id/view',
		(req, res, next) => {
			req.controllerData = req.controllerData || {};
			Cron.findOne({ _id: req.params.id })
				.then(result => {
					req.controllerData.cron = result;
					return next();
				});
		}, handleResponseData);
	cronController.router.get('/crons/view/all',
		CoreController.controller_load_model_with_count(cronSettings),
		CoreController.controller_load_model_with_default_limit(cronSettings),
		CoreController.controller_model_query(cronSettings),
		handleResponseData);

	return cronController;
};