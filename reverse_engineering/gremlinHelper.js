const _ = require('lodash');
let sshTunnel;
const fs = require('fs');
const ssh = require('tunnel-ssh');
const gremlin = require('gremlin');

let client;
let graphName = 'g';

const getSshConfig = (info) => {
	const config = {
		username: info.ssh_user,
		host: info.ssh_host,
		port: info.ssh_port,
		dstHost: info.host,
		dstPort: info.port,
		localHost: '127.0.0.1',
		localPort: info.port,
		keepAlive: true
	};

	if (info.ssh_method === 'privateKey') {
		return Object.assign({}, config, {
			privateKey: fs.readFileSync(info.ssh_key_file),
			passphrase: info.ssh_key_passphrase
		});
	} else {
		return Object.assign({}, config, {
			password: info.ssh_password
		});
	}
};

const connectViaSsh = (info) => new Promise((resolve, reject) => {
	ssh(getSshConfig(info), (err, tunnel) => {
		if (err) {
			reject(err);
		} else {
			resolve({
				tunnel,
				info: Object.assign({}, info, {
					host: '127.0.0.1'
				})
			});
		}
	});
});

const connect = info => {
	if (info.ssh) {
		return connectViaSsh(info)
			.then(({ info, tunnel }) => {
				sshTunnel = tunnel;

				return connectToInstance(info);
			});
	} else {
		return connectToInstance(info);
	}
};

const connectToInstance = (info) => {
	return new Promise((resolve, reject) => {
		const host = info.host;
		const port = info.port;
		const username = info.username;
		const password = info.password;
		const traversalSource = info.traversalSource || 'g';
		const needSasl = username && password;
		const sslOptions = getSSLConfig(info);
		const protocol = _.isEmpty(sslOptions) ? 'ws' : 'wss';
		const authenticator = needSasl ? new gremlin.driver.auth.PlainTextSaslAuthenticator(username, password) : undefined;
		
		client = new gremlin.driver.Client(`${protocol}://${host}:${port}/gremlin`, Object.assign({
			authenticator,
			traversalSource
		}, sslOptions));

		client.open()
			.then(res => {
				graphName = traversalSource;
				resolve();
			}).catch(error => {
				reject(error);
			});
	});
};

const testConnection = () => {
	if (!client) {
		return Promise.reject('Connection error');
	}

	return client.submit(`${graphName}.V().next()`);
};

const close = () => {
	if (client) {
		client.close();
		client = null;
	}
	if (sshTunnel) {
		sshTunnel.close();
		sshTunnel = null;
	}
};

const getLabels = () => {
	return client.submit(`${graphName}.V().label().dedup().toList()`).then(data => data.toArray());
};

const getRelationshipSchema = (labels, limit = 100) => {
	return Promise.all(labels.map(label => {
		return client.submit(`${graphName}.V().hasLabel('${label}').outE().limit(${limit}).as('edge').inV().as('end')
			.select('edge', 'end').by(label).dedup().toList()`)
				.then(relationshipData => {
					const relationship = _.first(relationshipData.toArray());
					if (!relationship) {
						return {};
					}
					return {
						start: label,
						relationship: relationship.get('edge'),
						end: relationship.get('end')
					}
				})
	}));
};

const getDatabaseName = () => {
	return Promise.resolve(graphName)
};

const getItemProperties = propertiesMap => {
	return Array.from(propertiesMap).reduce((obj, [key, rawValue]) => {
		if (!_.isString(key)) {
			return obj;
		}

		const value = _.isArray(rawValue) ? _.first(rawValue) : rawValue;

		if (_.isMap(value)) {
			return Object.assign(obj, { [key]: handleMap(value) })
		}

		return Object.assign(obj, { [key]: value });
	}, {});
};

const handleMap = map => {
	return Array.from(map).reduce((obj, [key, value]) => {
		if (_.isMap(value)) {
			return Object.assign(obj, { [key]: handleMap(value) })
		}

		return Object.assign(obj, { [key]: value });
	}, {});
};

const getNodes = (label, limit = 100) => {
	return client.submit(`${graphName}.V().hasLabel('${label}').limit(${limit}).valueMap(true).toList()`).then(res => 
		res.toArray().map(getItemProperties)
	)
};

const getRelationshipData = (start, relationship, end, limit = 100) => {
	return client.submit(`${graphName}.E().hasLabel('${relationship}').where(and(
			outV().label().is(eq('${start}')),
			inV().label().is(eq('${end}')))
		).limit(${limit}).valueMap(true).toList()`)
			.then(relationshipData => relationshipData.toArray().map(getItemProperties))
			.then(documents => getSchema('E', documents, relationship, limit))
};

const getNodesCount = (label) => {
	return client.submit(`${graphName}.V().hasLabel('${label}').count().next()`).then(res => res.first());
};

const getCountRelationshipsData = (start, relationship, end) => {
	return client.submit(`${graphName}.E().hasLabel('${relationship}').where(and(
		outV().label().is(eq('${start}')),
		inV().label().is(eq('${end}')))
	).count().next()`).then(data => data.toArray());
};

const getIndexes = () => {
	return Promise.all([
			client.submit(`graph.getIndexedKeys(Vertex)`),
			client.submit(`graph.getIndexedKeys(Edge)`)
		])
		.then(data => {
			const vertexIndexesNames = data[0].toArray();
			const edgeIndexesNames = data[1].toArray();
			const vertexIndexes = vertexIndexesNames.map(name =>({
				name,
				elementType: 'Vertex',
				propertyName: name
			}));
			const edgeIndexes = edgeIndexesNames.map(name =>({
				name,
				elementType: 'Edge',
				propertyName: name
			}));

			return vertexIndexes.concat(edgeIndexes);
		});
};

const getFeatures = () => client.submit('graph.features()').then(data => {
	const features = data.first();
	if (!_.isString(features)) {
		return '';
	}

	return features.slice('FEATURES '.length);
});

const getVariables = () => client.submit('graph.variables().asMap()').then(data => {
	const variablesMaps = data.toArray();
	const variables = variablesMaps.map(handleMap);
	const formattedVariables = variables.map(variableData => {
		const variable = _.first(Object.keys(variableData));
		const variableRawValue = variableData[variable];
		const variableValue = _.isString(variableRawValue) ? variableRawValue : JSON.stringify(variableData[variable]);

		return {
			graphVariableKey: variable,
			GraphVariableValue: variableValue
		};
	});

	return formattedVariables;
});

const convertRootPropertyValue = property => {
	const value = property['@value'];
	if (property['@type'] !== 'g:List' || !_.isArray(value)) {
		return convertGraphSonToSchema(property);
	}

	if (value.length === 1) {
		return convertGraphSonToSchema(_.first(value));
	}

	return {
		type: 'multi-property',
		items: value.map(convertGraphSonToSchema)
	}
};

const isChoice = item => item.oneOf;

const addSubtype = (choice, subschema) => {
	let hasSameTypeSubschema = false;
	const subschemas = choice.oneOf.map(item => {
		if (item.type === subschema.type) {
			hasSameTypeSubschema = true;

			return mergeSchemas(item, subschema);
		}

		return item;
	});

	if (hasSameTypeSubschema) {
		return Object.assign({}, choice, {
			oneOf: subschemas
		});
	}

	return Object.assign({}, choice, {
		oneOf: subschemas.concat(subschema)
	});
};

const convertToChoice = item => ({
	type: 'choice',
	oneOf: [item]
});

const convertRootGraphSON = propertiesMap => {
	if (_.get(propertiesMap, '@type') !== 'g:Map') {
		return {};
	}

	const properties = propertiesMap['@value'];
	const { keys, values} = properties.reduce(({keys, values}, property, index) => {
		if (index % 2) {
			return { keys, values: [ ...values, convertRootPropertyValue(property)] };
		}
		
		if (_.isObject(property)) {
			return { key, values };
		}

		return { keys: [ ...keys, property + ''], values };
	}, { keys: [], values: [] });

	return { properties: keys.reduce((properties, key, index) => {
		return Object.assign({}, properties, {
			[key]: values[index] || {}
		});
	}, {}) };
};

const mergeJsonSchemas = schemas => schemas.reduce(mergeSchemas, {});

const getMergedProperties = (a, b) => {
	if (_.isEmpty(a.properties) && _.isEmpty(b.properties)) {
		return {};
	}
	
	if (_.isEmpty(a.properties)) {
		a.properties = {};
	}

	if (_.isEmpty(b.properties)) {
		b.properties = {};
	}

	const allPropertiesKeys = _.uniq([ ...Object.keys(a.properties), ...Object.keys(b.properties) ])
	const mergedProperties = allPropertiesKeys.reduce((properties, key) => {
		const mergedValue = mergeSchemas(a.properties[key], b.properties[key]);

		return Object.assign({}, properties, {
			[key]: mergedValue
		});
	}, {});

	return { properties: mergedProperties };
};

const getMergedItems = (a, b) => {
	if (_.isEmpty(a.items) && _.isEmpty(b.items)) {
		return {};
	}
	
	if (_.isEmpty(a.items)) {
		a.items = [];
	}

	if (_.isEmpty(b.items)) {
		b.items = [];
	}

	const mergedItems = _.uniqBy(a.items.concat(b.items), 'type')

	return { items: mergedItems };
};

const isComplexType = field => {
	const type = field.type;
	if (!type){
		return false;
	}

	return ['list', 'set', 'map'].includes(type);
};

const mergeTypes = (a, b) => {
	if (isChoice(a)) {
		return addSubtype(a, b)
	}
	
	if (_.isArray(a.type) && !isComplexType(b)) {
		if (a.type.includes(b.type)) {
			return a;
		}

		return Object.assign({}, a, { type: a.type.concat(b.type) });
	}
	
	if (!_.isComplexType(a) && !isComplexType(b)) {
		return Object.assign({}, a, { type: [a.type, b.type] });
	}

	const choice = convertToChoice(a);

	return addSubtype(choice, b);
	
}

const mergeSchemas = (a, b) => {
	if (_.isEmpty(a)) {
		a = {};
	}
	if (_.isEmpty(b)) {
		b = {};
	}
	const properties = getMergedProperties(a, b);
	const items = getMergedItems(a, b);

	const typeConflict = a.type && b.type && a.type !== b.type;
	const merged = typeConflict ? mergeTypes(a, b) : Object.assign({}, a, b);

	return Object.assign({}, merged, items, properties);
};

const handleChoice = (choice, name = '') => ({
	type: 'choice',
	choice: 'oneOf',
	items: choice.oneOf.map(subschema => ({
		type: 'subschema',
		properties: {
			[name]: subschema
		}
	}))
});

const handleChoicesInProperties = schema => {
	if (!schema.properties) {
		return schema;
	}
	const updatedProperties = Object.keys(schema.properties).reduce((properties, key) => {
		const property = schema.properties[key];
		const handledProperty = handleChoices(property);
		if (!isChoice(property)) {
			return Object.assign({}, properties, {
				[key]: handleChoices(handledProperty)
			});
		}

		return Object.assign({}, properties, {
			[key]: handleChoice(handledProperty, key)
		});
	}, {});

	return Object.assign({}, schema, {
		properties: updatedProperties
	});
};

const handleChoicesInItems = schema => {
	if (!schema.items) {
		return schema;
	}

	const updatedItems = schema.items.map(item => {
		const handledItem = handleChoices(item);
		if (!isChoice(handledItem)) {
			return handledItem;
		}

		return handleChoice(handledItem)
	});

	return Object.assign({}, schema, {
		items: updatedItems
	});
};

const convertMetaPropertySample = sample => {
	if (_.isUndefined(sample)) {
		return '';
	}

	if (_.isString(sample)) {
		return sample;
	}

	return JSON.stringify(sample);
}

const convertMetaProperty = metaPropertyMap => {
	if (_.get(metaPropertyMap, '@type') !== 'g:Map') {
		return {};
	}

	const propertyData = metaPropertyMap['@value'];
	const propertyName = propertyData[1];
	const metaProperty = propertyData[3];
	if (_.get(metaProperty, '@type') !== 'g:Map') {
		return {};
	}
	const { keys, values, samples} = metaProperty['@value'].reduce(({keys, values, samples}, property, index) => {
		if (index % 2) {
			return { 
				keys, 
				values: [ ...values, convertGraphSonToSchema(property)], 
				samples: [ ...samples, convertMetaPropertySample(property['@value'])]
			};
		}
		
		if (_.isObject(property)) {
			return { key, values, samples };
		}

		return { keys: [ ...keys, property + ''], values, samples };
	}, { keys: [], values: [], samples: []});
	
	const metaPropertiesTypes = values.map(value => value.type);
	const metaPropertiesData = keys.map((key, index) => ({
		metaPropName: key,
		metaPropType: metaPropertiesTypes[index] || 'map',
		metaPropSample: samples[index]
	}));

	return { [propertyName]: metaPropertiesData};
};

const addMetaProperties = (schema, metaProperties) => {
	const properties = schema.properties;
	const mergedMetaProperties = metaProperties.reduce((result, propertyData) => {
		const metaProperties = Object.keys(propertyData).reduce((result, key) => {
			const currentMetaProperties = _.get(result, key, []);
			return Object.assign({}, result, {
				[key]: currentMetaProperties.concat(propertyData[key])
			})
		}, {});

		return _.merge({}, result, metaProperties);
	}, {});

	const updatedProperties = Object.keys(mergedMetaProperties).reduce((resultProperties, key) => {
		const metaPropertyData = mergedMetaProperties[key];
		if (_.isEmpty(metaPropertyData) || !resultProperties[key]) {
			return resultProperties;
		}
		
		if (resultProperties[key].type !== 'multi-property') {
			const currentMetaProperties = _.get(resultProperties[key], 'metaProperties', []);
			return Object.assign({}, resultProperties, {
				[key]: Object.assign({}, resultProperties[key], {
					metaProperties: currentMetaProperties.concat(metaPropertyData)
				})
			});
		}

		const multiProperties = _.get(resultProperties, [key, 'items'], []);
		if (_.isEmpty(multiProperties)) {
			return resultProperties;
		}
		
		const updatedItems = multiProperties.map(property => {
			const currentMetaProperties = _.get(property, 'metaProperties', []);

			return Object.assign({}, property, {
				metaProperties: currentMetaProperties.concat(metaPropertyData)
			})
		});

		return Object.assign({}, resultProperties, {
			[key]: Object.assign({}, resultProperties[key], {
				items: updatedItems
			})
		});
	}, properties);
	
	return Object.assign({}, schema, {
		properties: updatedProperties
	});
}

const handleChoices = _.flow([handleChoicesInProperties, handleChoicesInItems]);

const submitGraphSONDataScript = query => {
	return client.submit(`GraphSONMapper.build().version(GraphSONVersion.V3_0).create().createMapper().writeValueAsString(${query})`);
}

const getDataQuery = (element, label, limit) => `${graphName}.${element}().hasLabel('${label}').limit(${limit}).valueMap().toList()`;

const getMetaPropertiesDataQuery = (label, limit) => 
	`${graphName}.V().hasLabel('${label}').limit(${limit}).properties().as('properties').
		as('metaProperties').select('properties','metaProperties').by(label).by(valueMap()).dedup().toList()`;

const getMetaPropertiesData = (element, label, limit) => {
	if (element !== 'V') {
		return Promise.resolve({
			first: () => ({})
		});
	}

	return submitGraphSONDataScript(getMetaPropertiesDataQuery(label, limit));
}


const getSchema = (gremlinElement, documents, label, limit = 100) => {
	return submitGraphSONDataScript(getDataQuery(gremlinElement, label, limit))
		.then(schemaData => {
			return getMetaPropertiesData(gremlinElement, label, limit)
				.then(metaPropertiesData => {
					return client.submit(`${graphName}.${gremlinElement}().hasLabel('${label}').limit(${limit}).properties().order().by(id).label().dedup().toList()`)
						.then(templateData => ({
							metaProperties: metaPropertiesData.first(),
							documentsGraphSONSchema: schemaData.first(),
							template: templateData.toArray()
						}))
						.catch(error => ({
							metaProperties: metaPropertiesData.first(),
							documentsGraphSONSchema: schemaData.first(),
							template: []
						}))
				});
		})
		.then(({ documentsGraphSONSchema, metaProperties, template }) => {
			try{
				const documentsSchema = JSON.parse(documentsGraphSONSchema)['@value'];
				const metaPropertiesMap = JSON.parse(metaProperties)['@value'];
				const documentsJsonSchemas = documentsSchema.map(convertRootGraphSON);
				const metaPropertiesByProperty = metaPropertiesMap.map(convertMetaProperty);
				const mergedJsonSchema = mergeJsonSchemas(documentsJsonSchemas);
				const jsonSchemaWithMetaProperties = addMetaProperties(mergedJsonSchema, metaPropertiesByProperty);

				return { documents, schema: handleChoices(jsonSchemaWithMetaProperties), template};
			} catch(e) {
				return { documents, schema: {}, template: []};
			}
		});
};

const getType = rawType => {
	switch(rawType) {
		case 'g:List':
			return { type: 'list' };
		case 'g:Map':
			return { type: 'map' };
		case 'g:Set':
			return { type: 'set' };
		case 'g:Double':
			return { type: 'number', mode: 'double' };
		case 'g:Int32':
			return { type: 'number', mode: 'integer' };
		case 'g:Int64':
			return { type: 'number', mode: 'long' };
		case 'g:Float':
			return { type: 'number', mode: 'float' };
		case 'g:Timestamp':
			return { type: 'timestamp' };
		case 'g:Date':
			return { type: 'date' };
		case 'g:UUID':
			return { type: 'uuid' };
		default: {
			return { type: 'map' };
		}
	}
};

const groupPropertiesForMap = properties => {
	const { keys, values} = properties.reduce(({keys, values}, property, index) => {
		if (index % 2) {
			return { keys, values: [ ...values, convertGraphSonToSchema(property)] };
		}

		return { keys: [ ...keys, property + ''], values };
	}, {
		keys: [],
		values: []
	});

	return keys.reduce((properties, key, index) => {
		return Object.assign({}, properties, {
			[key]: values[index] || {}
		});
	}, {});
};

const getItems = properties => properties.map(convertGraphSonToSchema);

const convertGraphSonToSchema = graphSON => {
	if (!_.isPlainObject(graphSON)) {
		return {
			type: typeof graphSON,
			sample: graphSON
		};
	}

	const rawType = graphSON['@type'];
	const { type, mode } = getType(rawType);
	const rawProperties = graphSON['@value'];

	if (rawType === 'g:Map') {
		const properties = groupPropertiesForMap(rawProperties);

		return { type, properties }
	}

	if (rawType === 'g:List' || rawType === 'g:Set') {
		const items = getItems(rawProperties);

		return { type, items }
	}

	if (mode) {
		return { type, mode, sample: rawProperties }
	}

	return { type, sample: rawProperties };
};

const getSSLConfig = (info) => {
	let config = {
		rejectUnauthorized: false
	};

	switch(info.sslType) {
		case "TRUST_ALL_CERTIFICATES":
		case "TRUST_SYSTEM_CA_SIGNED_CERTIFICATES":
			return config;
		case "TRUST_CUSTOM_CA_SIGNED_CERTIFICATES": {
			const cert = fs.readFileSync(info.certAuthority, 'utf8');
			config.ca = [cert];
			return config;
		}
		case "TRUST_SERVER_CLIENT_CERTIFICATES": {
			const pfx = fs.readFileSync(info.pfx);
			const cert = fs.readFileSync(info.certAuthority, 'utf8');
			config.ca = [cert];
			config.pfx = pfx;
			return config;
		}
		case "Off":
		default: 
			return {};
	}
};

module.exports = {
	connect,
	testConnection,
	close,
	getLabels,
	getRelationshipData,
	getRelationshipSchema,
	getDatabaseName,
	getNodes,
	getNodesCount,
	getCountRelationshipsData,
	getIndexes,
	getFeatures,
	getVariables,
	getSchema
};
