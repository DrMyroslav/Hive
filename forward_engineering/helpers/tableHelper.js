'use strict'

const {
	buildStatement,
	getName,
	getTab,
	indentString,
	replaceSpaceWithUnderscore,
	commentDeactivatedInlineKeys,
	removeRedundantTrailingCommaFromStatement,
	encodeStringLiteral,
} = require('./generalHelper');
const { getColumnsStatement, getColumnStatement, getColumns } = require('./columnHelper');
const keyHelper = require('./keyHelper');
const constraintHelper = require('./constraintHelper');
const { dependencies } = require('./appDependencies');

let _;
const setDependencies = ({ lodash }) => _ = lodash;

const getCreateStatement = ({
	dbName, tableName, isTemporary, isExternal, columnStatement, primaryKeyStatement, foreignKeyStatement, comment, partitionedByKeys, 
	clusteredKeys, sortedKeys, numBuckets, skewedStatement, rowFormatStatement, storedAsStatement, location, tableProperties, selectStatement,
	isActivated, ifNotExist, uniqueKeyStatement, checkStatement,
}) => {
	const temporary = isTemporary ? 'TEMPORARY' : '';
	const external = isExternal ? 'EXTERNAL' : '';
	const tempExtStatement = ' ' + [temporary, external].filter(d => d).map(item => item + ' ').join('');
	const fullTableName = dbName ? `${dbName}.${tableName}` : tableName;
	const hasConstraint = primaryKeyStatement || uniqueKeyStatement || checkStatement;

	return buildStatement(`CREATE${tempExtStatement}TABLE ${ifNotExist ? 'IF NOT EXISTS ' : ''}${fullTableName} (`, isActivated)
		(columnStatement, columnStatement + (hasConstraint  ? ',' : ''))
		(primaryKeyStatement, primaryKeyStatement + (uniqueKeyStatement ? ',' : ''))
		(uniqueKeyStatement, uniqueKeyStatement + (checkStatement ? ',' : ''))
		(checkStatement, checkStatement)
		(foreignKeyStatement, foreignKeyStatement)
		(true, ')')
		(comment, `COMMENT '${encodeStringLiteral(comment)}'`)
		(partitionedByKeys, `PARTITIONED BY (${partitionedByKeys})`)
		(clusteredKeys, `CLUSTERED BY (${clusteredKeys})`)
		(sortedKeys && clusteredKeys, `SORTED BY (${sortedKeys})`)
		(numBuckets && clusteredKeys, `INTO ${numBuckets} BUCKETS`)
		(skewedStatement, skewedStatement)
		(rowFormatStatement, `ROW FORMAT ${rowFormatStatement}`)
		(storedAsStatement, storedAsStatement)
		(location, `LOCATION "${location}"`)
		(tableProperties, `TBLPROPERTIES ${tableProperties}`)
		(selectStatement, `AS ${selectStatement}`)
		(true, ';')
		();
};

const getPrimaryKeyStatement = (jsonSchema, keysNames, deactivatedColumnNames, isParentItemActivated) => {
	const getStatement = (keys, constraintOptsStatement) => `PRIMARY KEY (${keys})${constraintOptsStatement}`;
	const options = (jsonSchema.primaryKey || [])[0] || {};
	const { rely, noValidateSpecification } = options;
	const constraintOptsStatement = constraintHelper.getConstraintOpts({ noValidateSpecification, rely, enableSpecification: 'DISABLE' })

	if (!Array.isArray(keysNames) || !keysNames.length) {
		return '';
	}
	if (!isParentItemActivated) {
		return getStatement(keysNames.join(', '), constraintOptsStatement);
	}

	const { isAllKeysDeactivated, keysString } = commentDeactivatedInlineKeys(keysNames, deactivatedColumnNames);
	if (isAllKeysDeactivated) {
		return '-- ' + getStatement(keysString, constraintOptsStatement);
	}
	return getStatement(keysString, constraintOptsStatement);
};

const getClusteringKeys = (clusteredKeys, deactivatedColumnNames, isParentItemActivated) => {
	if (!Array.isArray(clusteredKeys) || !clusteredKeys.length) {
		return '';
	}
	if (!isParentItemActivated) {
		return clusteredKeys.join(', ');
	}
	const { keysString } = commentDeactivatedInlineKeys(clusteredKeys, deactivatedColumnNames);
	return keysString;
};

const getSortedKeys = (sortedKeys, deactivatedColumnNames, isParentItemActivated) => {
	const getSortKeysStatement = keys => keys.map(sortedKey => `${sortedKey.name} ${sortedKey.type}`).join(', ');
	
	if (!Array.isArray(sortedKeys) || !sortedKeys.length) {
		return '';
	}
	const [activatedKeys, deactivatedKeys] = _.partition(sortedKeys, keyData => !deactivatedColumnNames.has(keyData.name));
	if (!isParentItemActivated || deactivatedKeys.length === 0) {
		return getSortKeysStatement(sortedKeys);
	}
	if (activatedKeys.length === 0) {
		return `/* ${getSortKeysStatement(deactivatedKeys)} */`;
	}

	return `${getSortKeysStatement(activatedKeys)} /*, ${getSortKeysStatement(deactivatedKeys)} */`;
};

const getPartitionKeyStatement = (keys, isParentActivated) => {
	const getKeysStatement = (keys) => keys.map(getColumnStatement).join(',');

	if (!Array.isArray(keys) || !keys.length) {
		return '';
	}

	const [activatedKeys, deactivatedKeys] = _.partition(keys, key => key.isActivated);
	if (!isParentActivated || deactivatedKeys.length === 0) {
		return getKeysStatement(keys);
	}
	if (activatedKeys.length === 0) {
		return `/* ${getKeysStatement(keys)} */`;
	}

	return `${getKeysStatement(activatedKeys)} /*, ${getKeysStatement(activatedKeys)} */`;
};

const getPartitionsKeys = (columns, partitions) => {
	return partitions.map(keyName => {
		return Object.assign({}, columns[keyName] || { type: 'string' }, { name: keyName }, { constraints: {} });
	}).filter(key => key);
};

const removePartitions = (columns, partitions) => {
	return partitions.reduce((columns, keyName) => {
		delete columns[keyName];

		return columns;
	}, Object.assign({}, columns));
};

const getSkewedKeyStatement = (skewedKeys, skewedOn, asDirectories, deactivatedColumnNames, isParentItemActivated) => {
	const getStatement = (keysString) => `SKEWED BY (${keysString}) ON ${skewedOn} ${asDirectories ? 'STORED AS DIRECTORIES' : ''}`;
	
	if (!Array.isArray(skewedKeys) || !skewedKeys.length) {
		return '';
	}

	if (!isParentItemActivated) {
		return getStatement(skewedKeys.join(', '));
	}

	const { isAllKeysDeactivated, keysString } = commentDeactivatedInlineKeys(skewedKeys, deactivatedColumnNames);
	if (isAllKeysDeactivated) {
		return '-- ' + getStatement(keysString);
	}
	return getStatement(keysString);
};

const getRowFormat = (tableData) => {
	if (tableData.storedAsTable !== 'textfile') {
		return '';
	}

	if (tableData.rowFormat === 'delimited') {
		return buildStatement(`DELIMITED`)
			(tableData.fieldsTerminatedBy, `FIELDS TERMINATED BY '${tableData.fieldsTerminatedBy}'`)
			(tableData.fieldsescapedBy, `ESCAPED BY '${tableData.fieldsescapedBy}'`)
			(tableData.collectionItemsTerminatedBy, `COLLECTION ITEMS TERMINATED BY '${tableData.collectionItemsTerminatedBy}'`)
			(tableData.mapKeysTerminatedBy, `MAP KEYS TERMINATED BY '${tableData.mapKeysTerminatedBy}'`)
			(tableData.linesTerminatedBy, `LINES TERMINATED BY '${tableData.linesTerminatedBy}'`)
			(tableData.nullDefinedAs, `NULL DEFINED AS '${tableData.nullDefinedAs}'`)
			();
	} else if (tableData.rowFormat === 'SerDe') {
		return buildStatement(`SERDE '${tableData.serDeLibrary}'`)
			(tableData.serDeProperties, `WITH SERDEPROPERTIES ${tableData.serDeProperties}`)
			();
	}
};

const getStoredAsStatement = (tableData) => {
	if (!tableData.storedAsTable) {
		return '';
	}

	if (tableData.storedAsTable === 'input/output format') {
		let statement = [];

		if (tableData.serDeLibrary) {
			statement.push(`ROW FORMAT SERDE '${tableData.serDeLibrary}'`);
		}
		statement.push(`STORED AS INPUTFORMAT '${tableData.inputFormatClassname}'`);
		statement.push(`OUTPUTFORMAT '${tableData.outputFormatClassname}'`);

		return statement.join('\n');
	}

	if (tableData.storedAsTable === 'by') {
		return `STORED BY '${tableData.serDeLibrary}'`;
	}

	return `STORED AS ${tableData.storedAsTable.toUpperCase()}`;
};

const getTableStatement = (containerData, entityData, jsonSchema, definitions, foreignKeyStatement, areColumnConstraintsAvailable, areForeignPrimaryKeyConstraintsAvailable) => {
	setDependencies(dependencies);
	
	const dbName = replaceSpaceWithUnderscore(getName(getTab(0, containerData)));
	const tableData = getTab(0, entityData);
	const container = getTab(0, containerData);
	const isTableActivated = tableData.isActivated && (typeof container.isActivated === 'boolean' ? container.isActivated : true);
	const tableName = replaceSpaceWithUnderscore(getName(tableData));
	const { columns, deactivatedColumnNames } = getColumns(jsonSchema, areColumnConstraintsAvailable, definitions);
	const keyNames = keyHelper.getKeyNames(tableData, jsonSchema, definitions, areColumnConstraintsAvailable);

	const tableStatement = getCreateStatement({
		dbName,
		tableName,
		isTemporary: tableData.temporaryTable,
		isExternal: tableData.externalTable,
		columnStatement: getColumnsStatement(removePartitions(columns, keyNames.compositePartitionKey), isTableActivated),
		primaryKeyStatement: areForeignPrimaryKeyConstraintsAvailable ? getPrimaryKeyStatement(jsonSchema, keyNames.primaryKeys, deactivatedColumnNames, isTableActivated) : null,
		uniqueKeyStatement: areForeignPrimaryKeyConstraintsAvailable ? constraintHelper.getUniqueKeyStatement(jsonSchema, deactivatedColumnNames, isTableActivated) : null,
		checkStatement: areColumnConstraintsAvailable ? constraintHelper.getCheckConstraint(jsonSchema) : null,
		foreignKeyStatement: areForeignPrimaryKeyConstraintsAvailable ? foreignKeyStatement : null,
		comment: tableData.description,
		partitionedByKeys: getPartitionKeyStatement(getPartitionsKeys(columns, keyNames.compositePartitionKey, isTableActivated)),
		clusteredKeys: getClusteringKeys(keyNames.compositeClusteringKey, deactivatedColumnNames, isTableActivated),
		sortedKeys: getSortedKeys(keyNames.sortedByKey, deactivatedColumnNames, isTableActivated), 
		numBuckets: tableData.numBuckets,
		skewedStatement: getSkewedKeyStatement(keyNames.skewedby, tableData.skewedOn, tableData.skewStoredAsDir, deactivatedColumnNames, isTableActivated),
		rowFormatStatement: getRowFormat(tableData),
		storedAsStatement: getStoredAsStatement(tableData),
		location: tableData.location,
		tableProperties: tableData.tableProperties,
		selectStatement: '',
		isActivated: isTableActivated,
		ifNotExist: tableData.ifNotExist,
	});

	return removeRedundantTrailingCommaFromStatement(tableStatement);
};

module.exports = {
	getTableStatement
};
