'use strict';

const async = require('async');
const _ = require('lodash');
const gremlinHelper = require('./gremlinHelper');

module.exports = {
	connect: function(connectionInfo, logger, cb){
		logger.clear();
		logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);
		gremlinHelper.connect(connectionInfo).then(cb, cb);
	},

	disconnect: function(connectionInfo, cb){
		gremlinHelper.close();
		cb();
	},

	testConnection: function(connectionInfo, logger, cb){
		this.connect(connectionInfo, logger, error => {
			if (error) {
				cb(error);
				return;
			}

			gremlinHelper.testConnection().then(() => {
				this.disconnect(connectionInfo, () => {});
				cb();
			}).catch(error => {
				this.disconnect(connectionInfo, () => {});
				logger.log('error', prepareError(error));
				cb(error);
			})
		});
	},

	getDatabases: function(connectionInfo, logger, cb){
		cb();
	},

	getDocumentKinds: function(connectionInfo, logger, cb) {
		cb();
	},

	getDbCollectionsNames: function(connectionInfo, logger, cb) {
		let result = {
			dbName: '',
			dbCollections: ''
		};
		gremlinHelper.connect(connectionInfo).then(() => {
			return gremlinHelper.getLabels();
		}).then((labels) => {
			result.dbCollections = labels;
		}).then(() => {
			return gremlinHelper.getDatabaseName();
		}).then(dbName => {
			result.dbName = dbName;
			
			cb(null, [result]);
		}).catch((error) => {
			cb(error || 'error');
		});
	},

	getDbCollectionsData: function(data, logger, cb){
		logger.clear();
		logger.log('info', data, 'connectionInfo', data.hiddenKeys);

		const collections = data.collectionData.collections;
		const dataBaseNames = data.collectionData.dataBaseNames;
		const fieldInference = data.fieldInference;
		const includeEmptyCollection = data.includeEmptyCollection;
		const includeSystemCollection = data.includeSystemCollection;
		const recordSamplingSettings = data.recordSamplingSettings;
		let packages = {
			labels: [],
			relationships: []
		};

		async.map(dataBaseNames, (dbName, next) => {
			let labels = collections[dbName];
			let metaData = {};

			gremlinHelper.getFeatures().then(features => {
				metaData.features = features;
			}).then(() => gremlinHelper.getVariables()
			).then(variables => {
				metaData.variables = variables;
			}).then(() => gremlinHelper.getIndexes()
			).then(indexes => {
				logger.progress({ message: `Indexes have retrieved successfully`, containerName: dbName, entityName: '' });
				metaData.indexes = indexes;
				return metaData;
			}).then(metaData => {
				return getNodesData(dbName, labels, logger, {
					recordSamplingSettings,
					fieldInference,
					includeEmptyCollection,
					indexes: metaData.indexes,
					features: metaData.features,
					variables: metaData.variables
				});
			}).then((labelPackages) => {
				packages.labels.push(labelPackages);
				labels = labelPackages.reduce((result, packageData) => result.concat([packageData.collectionName]), []);
				return gremlinHelper.getRelationshipSchema(labels);
			}).then((schema) => {
				return schema.filter(data => {
					return (labels.indexOf(data.start) !== -1 && labels.indexOf(data.end) !== -1);
				});
			}).then((schema) => {
				return getRelationshipData(schema, dbName, recordSamplingSettings, fieldInference);
			}).then((relationships) => {
				packages.relationships.push(relationships);
				next(null);
			}).catch(error => {
				logger.log('error', prepareError(error), "Error");
				next(prepareError(error));
			});
		}, (err) => {
			cb(err, packages.labels, {}, [].concat.apply([], packages.relationships));
		});
	}
};

const getCount = (count, recordSamplingSettings) => {
	const per = recordSamplingSettings.relative.value;
	const size = (recordSamplingSettings.active === 'absolute')
		? recordSamplingSettings.absolute.value
		: Math.round(count / 100 * per);
	return size;
};

const isEmptyLabel = (documents) => {
	if (!Array.isArray(documents)) {
		return true;
	}

	return documents.reduce((result, doc) => result && _.isEmpty(doc), true);
};

const getTemplate = (documents, rootTemplateArray = []) => {
	const template = rootTemplateArray.reduce((template, key) => Object.assign({}, template, { [key]: {} }), {});

	if (!_.isArray(documents)) {
		return template;
	}

	return documents.reduce((tpl, doc) => _.merge(tpl, doc), template);
};

const getNodesData = (dbName, labels, logger, data) => {
	return new Promise((resolve, reject) => {
		let packages = [];
		async.map(labels, (labelName, nextLabel) => {
			logger.progress({ message: 'Start sampling data', containerName: dbName, entityName: labelName });
			gremlinHelper.getNodesCount(labelName)
			.then(quantity => {
				logger.progress({ message: 'Start getting data from graph', containerName: dbName, entityName: labelName });
				const count = getCount(quantity, data.recordSamplingSettings);

				return gremlinHelper.getNodes(labelName, count).then(documents => (
					{ limit: count, documents }
				));
			})
			.then(({ documents, limit }) => gremlinHelper.getSchema('V', documents, labelName, limit))
			.then(({ documents, schema, template }) => {
				logger.progress({ message: `Data has successfully got`, containerName: dbName, entityName: labelName });
				const packageData = getLabelPackage({
					dbName, 
					labelName, 
					documents,
					schema,
					template,
					includeEmptyCollection: data.includeEmptyCollection, 
					fieldInference: data.fieldInference,
					indexes: data.indexes,
					features: data.features,
					variables: data.variables
				});
				if (packageData) {
					packages.push(packageData);
				}
				nextLabel(null);
			}).catch(nextLabel);
		}, (err) => {
			if (err) {
				reject(err);
			} else {
				resolve(packages);
			}
		});
	});
};

const getRelationshipData = (schema, dbName, recordSamplingSettings, fieldInference) => {
	return new Promise((resolve, reject) => {
		async.map(schema, (chain, nextChain) => {
			gremlinHelper.getCountRelationshipsData(chain.start, chain.relationship, chain.end).then((quantity) => {
				const count = getCount(quantity, recordSamplingSettings);
				return gremlinHelper.getRelationshipData(chain.start, chain.relationship, chain.end, count);
			})
			.then(({ documents, schema, template }) => {
				let packageData = {
					dbName,
					parentCollection: chain.start, 
					relationshipName: chain.relationship, 
					childCollection: chain.end,
					documents,
					validation: {
						jsonSchema: schema
					}
				};

				if (fieldInference.active === 'field') {
					packageData.documentTemplate = getTemplate(documents, template);
				}

				nextChain(null, packageData);
			}).catch(nextChain);
		}, (err, packages) => {
			if (err) {
				reject(err);
			} else {
				resolve(packages);
			}
		});
	});
};

const getLabelPackage = ({dbName, labelName, documents, template, schema, includeEmptyCollection, fieldInference, indexes, features, variables}) => {
	let packageData = {
		dbName,
		collectionName: labelName,
		documents,
		views: [],
		emptyBucket: false,
		validation: {
			jsonSchema: schema
		},
		bucketInfo: {
			indexes,
			features,
			graphVariables: variables,
			traversalSource: dbName
		}
	};

	if (fieldInference.active === 'field') {
		packageData.documentTemplate = getTemplate(documents, template);
	}

	if (includeEmptyCollection || !isEmptyLabel(documents)) {
		return packageData;
	} else {
		return null;
	}
}; 

const prepareError = (error) => {
	return {
		message: error.message,
		stack: error.stack
	};
};
