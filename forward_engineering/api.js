const DEFAULT_INDENT = '    ';
let graphName = 'g';

module.exports = {
	generateContainerScript(data, logger, cb) {
		try {
			cb(null, '');
		} catch(e) {
			logger.log('error', { message: e.message, stack: e.stack }, 'Forward-Engineering Error');
			setTimeout(() => {
				cb({ message: e.message, stack: e.stack });
			}, 150);
			return;
		}
	}
};

const generateVariables = variables => {
	return variables.reduce((script, variable) => {
		const key = variable.graphVariableKey;
		const value = variable.GraphVariableValue || '';
		if (!key) {
			return script;
		}
		try {
			const parsedValue = JSON.parse(value);
			if (!_.isString(parsedValue)) {
				return script + `graph.variables().set("${key}", ${value});\n`;
			}

			return script + `graph.variables().set("${key}", "${value}");\n`;
		} catch (e) {
			return script + `graph.variables().set("${key}", "${value}");\n`
		}
	}, '');
};

const generateVertex = (collection, vertexData) => {
	const vertexName = collection.collectionName;
	const propertiesScript = addPropertiesScript(collection, vertexData);

	return `${graphName}.addV(${JSON.stringify(vertexName)})${propertiesScript}`;
};

const generateVertices = (collections, jsonData) => {
	const vertices = collections.map(collection => {
		const vertexData = JSON.parse(jsonData[collection.GUID]);

		return generateVertex(collection, vertexData)
	});	

	const script = vertices.join(';\n\n');
	if (!script) {
		return '';
	}

	return script + ';';
}

const generateEdge = (from, to, relationship, edgeData) => {
	const edgeName = relationship.name;
	const propertiesScript = addPropertiesScript(relationship, edgeData);

	return `${graphName}.addE(${JSON.stringify(edgeName)}).\n${DEFAULT_INDENT}from(${from}).\n${DEFAULT_INDENT}to(${to})${propertiesScript}`;
};

const getVertexVariableScript = vertexName => `${graphName}.V().hasLabel(${JSON.stringify(vertexName)}).next()`;

const generateEdges = (collections, relationships, jsonData) => {
	const edges = relationships.reduce((edges, relationship) => {
		const parentCollection = collections.find(collection => collection.GUID === relationship.parentCollection);
		const childCollection = collections.find(collection => collection.GUID === relationship.childCollection);
		if (!parentCollection || !childCollection) {
			return edges;
		}
		const from = transformToValidGremlinName(parentCollection.collectionName);
		const to = transformToValidGremlinName(childCollection.collectionName);
		const edgeData = JSON.parse(jsonData[relationship.GUID]);

		return edges.concat(generateEdge(getVertexVariableScript(from), getVertexVariableScript(to), relationship, edgeData));
	}, []);

	if (_.isEmpty(edges)) {
		return '';
	}

	return edges.join(';\n\n') + ';';
}

const getDefaultMetaPropertyValue = type => {
	switch(type) {
		case 'map': case 'list':
			return '[]';
		case 'set':
			return '[].toSet()';
		case 'string':
			return '"Lorem"';
		case 'number':
			return '1';
		case 'date':
			return 'new Date()';
		case 'timestamp':
			return 'new java.sql.Timestamp(1234567890123)';
		case 'uuid':
			return 'UUID.randomUUID()';
		case 'boolean':
			return 'true';
	}

	return '"Lorem"';
};

const handleMetaProperties = metaProperties => {
	if (!metaProperties){
		return '';
	}

	const metaPropertiesFlatList = metaProperties.reduce((list, property) => {
		if (!property.metaPropName) {
			return list;
		}

		const sample = _.isUndefined(property.metaPropSample) ? getDefaultMetaPropertyValue(property.metaPropType) : property.metaPropSample;

		return list.concat(
			JSON.stringify(property.metaPropName), 
			sample
		);
	}, []);

	return metaPropertiesFlatList.join(', ');
};

const handleMultiProperty = (property, name, jsonData) => {
	let properties = _.get(property, 'items', []);
	if (!_.isArray(properties)) {
		properties = [properties];
	}
	if (properties.length === 1) {
		properties = [ ...properties, ...properties];
		jsonData.push(_.first(jsonData));
	}

	const type = property.childType || property.type;
	const nameString = JSON.stringify(name);
	const propertiesValues = properties.map((property, index) => convertPropertyValue(property, 2, type, jsonData[index]));
	const metaProperties = properties.map(property => {
		const metaPropertiesScript = handleMetaProperties(property.metaProperties);
		if (_.isEmpty(metaPropertiesScript)) {
			return '';
		}

		return ', ' + metaPropertiesScript;
	});
	const cardinalities = properties.map(childProperty => childProperty.propCardinality || property.propCardinality);

	return propertiesValues.reduce((script, valueScript, index) => 
		`${script}.\n${DEFAULT_INDENT}property(${cardinalities[index]}, ${nameString}, ${valueScript}${metaProperties[index]})`
	, '');
};

const resolveChoices = (properties, choices) => {
	if (_.isEmpty(choices)) {
		return properties;
	}

	const choicePropertiesData = Object.keys(choices).map(choiceType => {
		const choiceData = choices[choiceType];
		const index = _.get(choiceData, 'meta.index');

		return {
			properties: _.first(choiceData.choice).properties || {},
			index
		};
	});

	const sortedChoices = choicePropertiesData.sort((a, b) => a.index - b.index);

	const fixedIndexesChoices = sortedChoices.map((choiceData, index, choicesData) => {
		if (index === 0) {
			return choiceData;
		}

		const additionalPropertiesCount = choicesData.reduce((count, choiceData, choiceDataIndex) => {
			if (choiceDataIndex >= index) {
				return count;
			}

			return count + Object.keys(choiceData.properties).length - 1;
		}, 0);

		return {
			properties: choiceData.properties,
			index: choiceData.index + additionalPropertiesCount
		};
	});

	return fixedIndexesChoices.reduce((sortedProperties, choiceData) => {
		const choiceProperties = choiceData.properties;
		const choicePropertiesIndex = choiceData.index;
		if (_.isEmpty(sortedProperties)) {
			return choiceProperties;
		}

		if (
			_.isUndefined(choicePropertiesIndex) ||
			Object.keys(sortedProperties).length <= choicePropertiesIndex
		) {
			return Object.assign({}, sortedProperties, choiceProperties);
		}

		return Object.keys(sortedProperties).reduce((result, propertyKey, index) => {
			if (index !== choicePropertiesIndex) {
				return Object.assign({}, result, {
					[propertyKey] : sortedProperties[propertyKey]
				});
			}

			return Object.assign({}, result, choiceProperties, {
				[propertyKey] : sortedProperties[propertyKey]
			});
		}, {});
	}, properties || {});
};

const addPropertiesScript = (collection, vertexData) => {
	const properties = _.get(collection, 'properties', {});
	const availableChoices = ['oneOf', 'allOf', 'anyOf'];
	const choices = availableChoices.reduce((choices, choiceType) => {
		const choice = _.get(collection, choiceType, []);
		if (_.isEmpty(choice)) {
			return choices;
		}

		return Object.assign({}, choices, {
			[choiceType]: {
				choice: _.get(collection, choiceType, []),
				meta: _.get(collection, `${choiceType}_meta`, {}),
			}
		});
	}, {});

	const propertiesWithResolvedChoices = resolveChoices(properties, choices);

	if (_.isEmpty(propertiesWithResolvedChoices)) {
		return '';
	}

	return Object.keys(propertiesWithResolvedChoices).reduce((script, name) => {
		const property = propertiesWithResolvedChoices[name];
		const type = property.childType || property.type;
		let metaPropertiesScript = handleMetaProperties(property.metaProperties);
		if (!_.isEmpty(metaPropertiesScript)) {
			metaPropertiesScript = ', ' + metaPropertiesScript;
		}
		if (type === 'multi-property') {
			return script + `${handleMultiProperty(property, name, vertexData[name])}`;
		}
		const valueScript = convertPropertyValue(property, 2, type, vertexData[name]);

		return script + `.\n${DEFAULT_INDENT}property(${property.propCardinality}, ${JSON.stringify(name)}, ${valueScript}${metaPropertiesScript})`;
	}, '');
};

const isGraphSONType = type => ['map', 'set', 'list', 'timestamp', 'date', 'uuid', 'number'].includes(type);

const convertMap = (property, level, value) => {
	const properties = property.properties;
	const childProperties = Object.keys(properties).map(name => ({
		name,
		property: properties[name]
	}));
	const indent = _.range(0, level).reduce(indent => indent + DEFAULT_INDENT, '');
	const previousIndent = _.range(0, level - 1).reduce(indent => indent + DEFAULT_INDENT, '');

	let mapValue = childProperties.reduce((result, {name, property}) => {
		const childValue = value[name];
		const type = property.childType || property.type;

		return result + `, \n${indent}${name}: ${convertPropertyValue(property, level + 1, type, childValue)}`;
	}, '');

	if (mapValue.slice(0, 2) === ', ') {
		mapValue = mapValue.slice(2);
	}

	return `[${mapValue}\n${previousIndent}]`;
};

const convertList = (property, level, value) => {
	let items = property.items;
	if (!_.isArray(items)) {
		items = [items];
	}

	let listValue = items.reduce((result, item, index) => {
		const childValue = value[index];
		const type = item.childType || item.type;

		return result + `, ${convertPropertyValue(item, level + 1, type, childValue)}`;
	}, '');

	if (listValue.slice(0, 2) === ', ') {
		listValue = listValue.slice(2)
	}

	return `[${listValue}]`;
};

const convertSet = (property, level, value) => {
	const setValue = convertList(property, level, value);

	return `${setValue}.toSet()`;
};

const convertTimestamp = value => `new java.sql.Timestamp(${JSON.stringify(value)})`;

const convertDate = value => `new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX").parse(${JSON.stringify(value)})`;

const convertUUID = value => `UUID.fromString(${JSON.stringify(value)})`;

const convertNumber = (property, value) => {
	const mode = property.mode;
	const numberValue = JSON.stringify(value);

	switch(mode) {
		case 'double':
			return `${numberValue}d`;
		case 'float':
			return `${numberValue}f`;
		case 'long':
			return `${numberValue}l`;
	}

	return numberValue;
};

const convertPropertyValue = (property, level, type, value) => {
	if (!isGraphSONType(type)) {
		return JSON.stringify(value);
	}

	switch(type) {
		case 'uuid':
			return convertUUID(value);
		case 'map':
			return convertMap(property, level, value);
		case 'set':
			return convertSet(property, level, value);
		case 'list':
			return convertList(property, level, value);
		case 'timestamp':
			return convertTimestamp(value);
		case 'date':
			return convertDate(value);
		case 'number':
			return convertNumber(property, value);
	}

	return convertMap(property, level, value);
};

const transformToValidGremlinName = name => {
	const DEFAULT_NAME = 'New_vertex';
	const DEFAULT_PREFIX = 'v_';

	if (!name || !_.isString(name)) {
		return DEFAULT_NAME;
	}

	const nameWithoutSpecialCharacters = name.replace(/[\s`~!@#%^&*()_|+\-=?;:'",.<>\{\}\[\]\\\/]/gi, '_');
	const startsFromDigit = nameWithoutSpecialCharacters.match(/^[0-9].*$/);

	if (startsFromDigit) {
		return `${DEFAULT_PREFIX}_${nameWithoutSpecialCharacters}`;
	}

	return nameWithoutSpecialCharacters;
};

const generateIndex = indexData => `graph.createIndex("${indexData.propertyName}", ${indexData.elementType || 'Vertex'})`;

const generateIndexes = indexesData => {
	const correctIndexes = indexesData.filter(index => index.propertyName);
	const script = correctIndexes.map(generateIndex).join(';\n');

	if (!script) {
		return '';
	}

	return script + ';';
};
