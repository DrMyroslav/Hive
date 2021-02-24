const { HiveParserVisitor } = require('./parser/HiveParserVisitor');
const { HiveParser } = require('./parser/HiveParser');
const _ = require('lodash');
const {
    CREATE_COLLECTION_COMMAND,
    REMOVE_COLLECTION_COMMAND,
    CREATE_BUCKET_COMMAND,
    REMOVE_BUCKET_COMMAND,
    USE_BUCKET_COMMAND,
    CREATE_DEFINITION_COMMAND,
    ADD_FIELDS_TO_COLLECTION_COMMAND,
    RENAME_FIELD_COMMAND,
    CREATE_VIEW_COMMAND,
    ADD_BUCKET_DATA_COMMAND,
    ADD_COLLECTION_LEVEL_INDEX_COMMAND,
    REMOVE_COLLECTION_LEVEL_INDEX_COMMAND,
    UPDATE_BUCKET_COMMAND,
    UPDATE_ENTITY_LEVEL_DATA_COMMAND,
    UPDATE_VIEW_LEVEL_DATA_COMMAND,
    ADD_FIELDS_TO_DEFINITION_COMMAND,
    ADD_RELATIONSHIP_COMMAND,
} = require('./commandsService');

const schemaHelper = require('./thriftService/schemaHelper');

const ALLOWED_COMMANDS = [
    HiveParser.RULE_createTableStatement,
    // HiveParser.RULE_dropTable,
    // HiveParser.RULE_alterTable,
    HiveParser.RULE_createDatabaseStatement,
    HiveParser.RULE_switchDatabaseStatement,
    HiveParser.RULE_dropDatabaseStatement,
    HiveParser.RULE_createViewStatement,
    HiveParser.RULE_createMaterializedViewStatement,
    HiveParser.RULE_alterStatement,
    // HiveParser.RULE_createFunction,
    // HiveParser.RULE_createAggregate,
    // HiveParser.RULE_alterKeyspace,
    // HiveParser.RULE_alterMaterializedView,
    HiveParser.RULE_createIndexStatement,
    HiveParser.RULE_dropIndexStatement,
];

class Visitor extends HiveParserVisitor {
    visitStatement(ctx) {
        const execStatement = ctx.execStatement();
        if (execStatement) {
            return this.visit(execStatement);
        }

        return;
    }

    visitExecStatement(ctx) {
        const ddlStatement = ctx.ddlStatement();
        if (ddlStatement) {
            return this.visit(ddlStatement);
        }

        return;
    }

    visitDdlStatement(ctx) {
        if (ALLOWED_COMMANDS.includes(ctx.children[0].ruleIndex)) {
            return super.visitDdlStatement(ctx)[0];
        }
        return;
    }

    visitCreateTableStatement(ctx) {
        const [tableName, tableLikeName] = this.visit(ctx.tableName());
        const compositePartitionKey = this.visitWhenExists(ctx, 'tablePartition', []);
        const { compositeClusteringKey, numBuckets, sortedByKey } = this.visitWhenExists(ctx, 'tableBuckets', {});
        const { skewedby, skewedOn, skewStoredAsDir } = this.visitWhenExists(ctx, 'tableSkewed', {});
        const tableRowFormat = this.visitWhenExists(ctx, 'tableRowFormat', {});
        const description = this.visitWhenExists(ctx, 'tableComment');
        const location = this.visitWhenExists(ctx, 'tableLocation');
        const tableProperties = this.visitWhenExists(ctx, 'tablePropertiesPrefixed');
        const temporaryTable = Boolean(ctx.KW_TEMPORARY());
        const externalTable = Boolean(ctx.KW_EXTERNAL());
        const storedAsTable = this.visitWhenExists(ctx, 'tableFileFormat', {});
        const { database, table } = tableName;
        const { properties, foreignKeys } = this.visitWhenExists(ctx, 'columnNameTypeOrConstraintList', {
            properties: {},
            foreignKeys: [],
        });
        const tableForeignKeys = foreignKeys.map((constraint) => ({
            ...constraint,
            childDbName: database,
            childCollection: table,
        }));

        // const asSelect = this.visitWhenExists(ctx, 'selectStatementWithCTE', {}); //TODO: handle asSelect statement

        return [
            {
                type: CREATE_COLLECTION_COMMAND,
                collectionName: table,
                bucketName: database,
                schema: handleChoices({
                    collectionName: table,
                    type: 'object',
                    properties: { ...properties, ...convertKeysToProperties(compositePartitionKey) },
                }),
                tableLikeName: (tableLikeName || {}).table,
                entityLevelData: _.pickBy(
                    {
                        temporaryTable,
                        externalTable,
                        description,
                        compositePartitionKey: compositePartitionKey.map((key) => ({ name: key.name })),
                        compositeClusteringKey,
                        numBuckets,
                        sortedByKey,
                        skewedby,
                        skewedOn,
                        skewStoredAsDir,
                        location,
                        tableProperties,
                        ...storedAsTable,
                        ...tableRowFormat,
                    },
                    (prop) => !_.isEmpty(prop)
                ),
            },
            ...tableForeignKeys.map((fkData) => ({
                ...fkData,
                type: ADD_RELATIONSHIP_COMMAND,
            })),
        ];
    }

    visitAtomSelectStatement(ctx) {
        return this.visitWhenExists(ctx, 'fromClause', {});
    }

    visitSelectStatement(ctx) {
        return this.visit(ctx.atomSelectStatement());
    }

    visitFromClause(ctx) {
        return this.visit(ctx.fromSource());
    }

    visitFromSource(ctx) {
        return this.visitWhenExists(ctx, 'joinSource') || this.visitWhenExists(ctx, 'uniqueJoinSource');
    }

    visitUniqueJoinSource(ctx) {
        return this.visit(ctx.uniqueJoinTableSource());
    }

    visitUniqueJoinTableSource(ctx) {
        return this.visit(ctx.tableName());
    }

    visitJoinSource(ctx) {
        return this.visit(ctx.atomjoinSource());
    }

    visitAtomjoinSource(ctx) {
        return this.visitWhenExists(ctx, 'tableSource') || this.visitWhenExists(ctx, 'joinSource');
    }

    visitTableSource(ctx) {
        return this.visit(ctx.tableName());
    }

    visitTablePartition(ctx) {
        return this.visit(ctx.columnNameTypeConstraint());
    }

    visitTableComment(ctx) {
        return getTextFromStringLiteral(ctx);
    }

    visitTableBuckets(ctx) {
        const hasNumber = Boolean(ctx.Number());
        const hasSort = Boolean(ctx.columnNameOrderList());

        return {
            compositeClusteringKey: ctx
                .columnNameList()
                .getText()
                .split(',')
                .map((name) => ({ name })),
            ...(hasSort ? { sortedByKey: this.visit(ctx.columnNameOrderList()) } : {}),
            ...(hasNumber ? { numBuckets: Number(ctx.Number().getText()) } : {}),
        };
    }

    visitColumnNameOrderList(ctx) {
        return this.visit(ctx.columnNameOrder());
    }

    visitColumnNameOrder(ctx) {
        return {
            name: ctx.identifier().getText(),
            type: getOrderType(this.visitWhenExists(ctx, 'orderSpecification')),
        };
    }

    visitOrderSpecification(ctx) {
        return ctx.getText();
    }

    visitTableSkewed(ctx) {
        return {
            skewedby: this.visit(ctx.columnNameList()),
            skewedOn: `(${ctx.skewedValueElement().getText()})`,
            ...(ctx.storedAsDirs() ? { skewStoredAsDir: true } : {}),
        };
    }

    visitTableRowFormat(ctx) {
        const isDelimited = Boolean(ctx.rowFormatDelimited());

        if (isDelimited) {
            return {
                rowFormat: 'delimited',
                ...this.visit(ctx.rowFormatDelimited()),
            };
        } else {
            return {
                rowFormat: 'SerDe',
                ...this.visit(ctx.rowFormatSerde()),
            };
        }
    }

    visitRowFormatDelimited(ctx) {
        const { fieldsTerminatedBy, fieldsescapedBy } = this.visitWhenExists(ctx, 'tableRowFormatFieldIdentifier', {});
        return {
            fieldsTerminatedBy,
            fieldsescapedBy,
            collectionItemsTerminatedBy: this.visitWhenExists(ctx, 'tableRowFormatCollItemsIdentifier'),
            mapKeysTerminatedBy: this.visitWhenExists(ctx, 'tableRowFormatMapKeysIdentifier'),
            linesTerminatedBy: this.visitWhenExists(ctx, 'tableRowFormatLinesIdentifier'),
            nullDefinedAs: this.visitWhenExists(ctx, 'tableRowNullFormat'),
        };
    }

    visitTableRowFormatFieldIdentifier(ctx) {
        return {
            fieldsTerminatedBy: getTextFromStringLiteral(ctx),
            fieldsescapedBy: this.visitWhenExists(ctx, 'tableRowFormatFieldIdentifierEcapedBy'),
        };
    }

    visitTableRowFormatCollItemsIdentifier(ctx) {
        return getTextFromStringLiteral(ctx);
    }

    visitTableRowFormatMapKeysIdentifier(ctx) {
        return getTextFromStringLiteral(ctx);
    }

    visitTableRowFormatLinesIdentifier(ctx) {
        return getTextFromStringLiteral(ctx);
    }

    visitTableRowNullFormat(ctx) {
        return getTextFromStringLiteral(ctx);
    }

    visitTableRowFormatFieldIdentifierEcapedBy(ctx) {
        return getTextFromStringLiteral(ctx);
    }

    visitRowFormatSerde(ctx) {
        return {
            serDeLibrary: getTextFromStringLiteral(ctx),
            serDeProperties: ctx.KW_SERDEPROPERTIES() ? ctx.tableProperties().getText() : '',
        };
    }

    visitTableLocation(ctx) {
        return getTextFromStringLiteral(ctx);
    }

    visitTablePropertiesPrefixed(ctx) {
        return ctx.tableProperties().getText();
    }

    visitCreateViewStatement(ctx) {
        const { database, table: name } = this.visit(ctx.tableName());
        const description = this.visitWhenExists(ctx, 'tableComment');
        const select = {
            start: ctx.selectStatementWithCTE().start.start,
            stop: ctx.selectStatementWithCTE().stop.stop,
        };
        const { table } = this.visitWhenExists(ctx, 'selectStatementWithCTE', {});

        return {
            type: CREATE_VIEW_COMMAND,
            name,
            bucketName: database,
            collectionName: table,
            jsonSchema: { properties: {} },
            select,
            data: {
                description,
            },
        };
    }

    visitCreateMaterializedViewStatement(ctx) {
        const { database, table: name } = this.visit(ctx.tableName());
        const description = this.visitWhenExists(ctx, 'tableComment');
        const select = {
            start: ctx.selectStatementWithCTE().start.start,
            stop: ctx.selectStatementWithCTE().stop.stop,
        };
        const { table } = this.visitWhenExists(ctx, 'selectStatementWithCTE', {});

        return {
            type: CREATE_VIEW_COMMAND,
            name,
            bucketName: database,
            collectionName: table,
            jsonSchema: { properties: {} },
            select,
            data: {
                description,
                materialized: true,
            },
        };
    }

    visitAlterStatement(ctx) {
        const isAlterTable = ctx.KW_TABLE();
        if (isAlterTable) {
            const { database, table } = this.visit(ctx.tableName());
            return {
                childDbName: database,
                childCollection: table,
                bucketName: database,
                ...this.visit(ctx.alterTableStatementSuffix()),
            };
        }

        return;
    }

    visitAlterTableStatementSuffix(ctx) {
        const constraint = ctx.alterStatementSuffixAddConstraint();
        if (constraint) {
            return this.visit(constraint);
        }

        return {};
    }

    visitAlterStatementSuffixAddConstraint(ctx) {
        const foreignKey = ctx.alterForeignKeyWithName();
        if (foreignKey) {
            return {
                type: ADD_RELATIONSHIP_COMMAND,
                ...this.visit(foreignKey),
            };
        }
        return {};
    }

    visitAlterForeignKeyWithName(ctx) {
        const [childField, parentField] = this.visit(ctx.columnParenthesesList());
        const { database: dbName, table: parentCollection } = this.visit(ctx.tableName());

        return {
            relationshipName: this.visit(ctx.identifier()),
            parentCollection,
            dbName,
            childField,
            parentField,
        };
    }

    visitSelectStatementWithCTE(ctx) {
        return this.visit(ctx.selectStatement());
    }

    visitColumnNameTypeOrConstraintList(ctx) {
        return this.visit(ctx.columnNameTypeOrConstraint()).reduce(
            ({ properties, foreignKeys }, column) => {
                if (!column) {
                    return { properties, foreignKeys };
                }
                if (column.isForeignKey) {
                    return {
                        foreignKeys: [...foreignKeys, column],
                        properties,
                    };
                }

                if (column.isConstraint) {
                    return {
                        foreignKeys,
                        properties,
                    };
                }

                const columnForeignKeys = column.foreignKey ? [column.foreignKey] : [];

                return {
                    properties: {
                        ...properties,
                        [column.name]: column.type,
                    },
                    foreignKeys: [...foreignKeys, ...columnForeignKeys],
                };
            },
            { properties: {}, foreignKeys: [] }
        );
    }

    visitColumnNameTypeOrConstraint(ctx) {
        const nameTypeConstraint = ctx.columnNameTypeConstraint();
        if (nameTypeConstraint) {
            return this.visit(nameTypeConstraint);
        }

        return this.visit(ctx.tableConstraint());
    }

    visitTableConstraint(ctx) {
        const fkConstraint = ctx.createForeignKey();
        if (fkConstraint) {
            return this.visit(fkConstraint);
        }

        return this.visit(ctx.createConstraint());
    }

    visitCreateConstraint(ctx) {
        const nameContext = ctx.identifier();
        const constraintName = nameContext ? this.visit(nameContext) : '';
        return {
            constraintName,
            ...this.visit(ctx.tableLevelConstraint()),
            isConstraint: true,
        };
    }

    visitTableLevelConstraint(ctx) {
        const pkUkConstraint = ctx.pkUkConstraint();
        return pkUkConstraint ? this.visit(pkUkConstraint) : {};
    }

    visitPkUkConstraint(ctx) {
        return {
            type: this.visit(ctx.tableConstraintType()),
            fields: this.visit(ctx.columnParenthesesList()),
        };
    }

    visitTableConstraintType(ctx) {
        return ctx.KW_PRIMARY() ? 'primary' : 'unique';
    }

    visitCreateForeignKey(ctx) {
        const nameContext = ctx.identifier();
        const { database: dbName, table: parentCollection } = this.visit(ctx.tableName());
        const [childField, parentField] = this.visit(ctx.columnParenthesesList());
        const relationshipName = nameContext ? this.visit(nameContext) : '';

        return {
            isForeignKey: true,
            relationshipName,
            parentCollection,
            dbName,
            childField,
            parentField,
        };
    }

    visitColumnParenthesesList(ctx) {
        return this.visit(ctx.columnNameList());
    }

    visitColumnNameList(ctx) {
        return this.visit(ctx.columnName());
    }

    visitColumnName(ctx) {
        return this.visit(ctx.identifier());
    }

    visitColumnNameTypeConstraint(ctx) {
        const name = this.visit(ctx.identifier());
        const type = this.visit(ctx.colType());
        const constraintContext = ctx.columnConstraint();
        const constraints = constraintContext && this.visit(constraintContext);
        const description = ctx.KW_COMMENT() ? getTextFromStringLiteral(ctx) : '';

        return {
            name,
            type: {
                ...type,
                description,
                ...mergeConstraints(constraints),
            },
        };
    }

    visitColType(ctx) {
        return this.visit(ctx.type_db_col());
    }

    visitType_db_col(ctx) {
        const primitiveType = ctx.primitiveType();
        const listType = ctx.listType();
        const structType = ctx.structType();
        const mapType = ctx.mapType();
        const unionType = ctx.unionType();

        if (primitiveType) {
            return this.visit(primitiveType);
        }

        if (listType) {
            return this.visit(listType);
        }

        if (structType) {
            return this.visit(structType);
        }

        if (mapType) {
            return this.visit(mapType);
        }

        if (unionType) {
            return this.visit(unionType);
        }
    }

    visitListType(ctx) {
        const items = this.visit(ctx.type_db_col());
        const isUnion = !items.type || Array.isArray(items.type);
        const itemType = isUnion ? 'union' : items.type;

        return {
            type: 'array',
            subtype: schemaHelper.getArraySubtypeByType(itemType),
            ...(!items.oneOf && { items }),
            ...(items.oneOf && { oneOf: getOneOf(items.oneOf, 'New column') }),
        };
    }

    visitUnionType(ctx) {
        const types = this.visit(ctx.colTypeList());
        const isComplex = (type) => ['struct', 'map', 'array'].indexOf(type) !== -1;
        const complexTypes = types.some((schema) => isComplex(schema.type));

        if (!complexTypes) {
            return {
                type: _.uniq(types.map((schema) => schema.type)),
            };
        }

        return {
            oneOf: types,
        };
    }

    visitColTypeList(ctx) {
        return this.visit(ctx.colType());
    }

    visitStructType(ctx) {
        return handleChoices({
            type: 'struct',
            properties: this.visit(ctx.columnNameColonTypeList()),
        });
    }

    visitColumnNameColonTypeList(ctx) {
        return this.visit(ctx.columnNameColonType()).reduce((properties, column) => {
            return {
                ...properties,
                [column.name]: column.type,
            };
        }, {});
    }

    visitColumnNameColonType(ctx) {
        return {
            name: this.visit(ctx.identifier()),
            type: this.visit(ctx.colType()),
        };
    }

    visitMapType(ctx) {
        const items = this.visit(ctx.type_db_col());
        const isUnion = !items.type || Array.isArray(items.type);
        const itemType = isUnion ? 'union' : items.type;
        const key = this.visit(ctx.primitiveType());

        return {
            type: 'map',
            subtype: schemaHelper.getMapSubtype(itemType),
            properties: items.oneOf ? {} : { 'New column': items },
            ...(items.oneOf && { oneOf: getOneOf(items.oneOf, 'New column') }),
            ...schemaHelper.getMapKeyType(key),
        };
    }

    visitPrimitiveType(ctx) {
        const timestampLocal = ctx.KW_TIMESTAMPLOCALTZ() || ctx.KW_LOCAL();
        const decimal = ctx.KW_DECIMAL();
        const varchar = ctx.KW_VARCHAR();
        const char = ctx.KW_CHAR();
        if (timestampLocal) {
            return { type: 'timestamp' };
        }
        if (decimal) {
            const decimalType = { type: 'numeric', mode: 'decimal' };
            const decimalData = ctx.Number();
            if (!decimalData) {
                return decimalType;
            }
            const { precision, scale } = this.visit(decimalData).map((number) => (isNaN(number) ? Number(number) : ''));

            return { ...decimalType, precision, scale };
        }
        if (varchar || char) {
            const charType = { type: 'text', mode: char ? 'char' : 'varchar' };
            let maxLength = this.visit(ctx.Number());
            if (Array.isArray(maxLength)) {
                maxLength = maxLength[0];
            }

            return { ...charType, maxLength };
        }

        const hiveType = ctx.getText().toLowerCase();

        switch (hiveType) {
            case 'string':
                return {
                    type: 'text',
                    mode: hiveType,
                };
            case 'int':
            case 'tinyint':
            case 'smallint':
            case 'bigint':
            case 'float':
            case 'double':
            case 'double precision':
                return {
                    type: 'numeric',
                    mode: hiveType,
                };
            case 'boolean':
                return {
                    type: 'bool',
                };
            case 'interval_day_time':
            case 'interval_year_month':
                return {
                    type: 'interval',
                };
            case 'binary':
            case 'timestamp':
            case 'date':
            case 'interval':
            default:
                return {
                    type: hiveType,
                };
        }
    }

    visitColumnConstraint(ctx) {
        return this.visit(ctx.colConstraint());
    }

    visitColConstraint(ctx) {
        return this.visit(ctx.columnConstraintType());
    }

    visitDefaultVal(ctx) {
        return ctx.getText();
    }

    visitColumnConstraintType(ctx) {
        return {
            required: Boolean(ctx.KW_NOT() && ctx.KW_NULL()),
            unique: Boolean((ctx.tableConstraintType() || {}).KW_UNIQUE),
            primaryKey: Boolean((ctx.tableConstraintType() || {}).KW_PRIMARY),
            default: ctx.KW_DEFAULT() ? this.visit(ctx.defaultVal()) : '',
            check: this.visitWhenExists(ctx, 'checkConstraint', ''),
        };
    }

    visitCheckConstraint(ctx) {
        return ctx.expression().getText();
    }

    visitNumber(ctx) {
        const value = ctx.getText();
        if (isNaN(value)) {
            return;
        }

        return Number(value);
    }

    visitTableName(ctx) {
        let names = this.visit(ctx.identifier());
        if (names.length === 1) {
            return {
                database: '',
                table: names[0],
            };
        }

        return {
            database: names[0],
            table: names[1],
        };
    }

    visitIdentifier(ctx) {
        return removeQuotes(ctx.getText());
    }

    visitStatementSeparator() {
        return;
    }

    visitTableFileFormat(ctx) {
        if (Boolean(ctx.tableInputOutputFileFormat())) {
            return {
                storedAsTable: 'input/output format',
                ...this.visit(ctx.tableInputOutputFileFormat()),
            };
        } else if (Boolean(ctx.tableFileFormatStoredBy())) {
            return {
                storedAsTable: 'by',
                ...this.visit(ctx.tableFileFormatStoredBy()),
            };
        } else if (Boolean(ctx.tableFileFormatStoredAs())) {
            return {
                storedAsTable: this.visit(ctx.tableFileFormatStoredAs()),
            };
        } else {
            return {};
        }
    }

    visitTableInputOutputFileFormat(ctx) {
        return {
            inputFormatClassname: this.visit(ctx.tableInputLiteral()),
            outputFormatClassname: this.visit(ctx.tableOutputLiteral()),
        };
    }

    visitTableInputLiteral(ctx) {
        return getTextFromStringLiteral(ctx);
    }

    visitTableOutputLiteral(ctx) {
        return getTextFromStringLiteral(ctx);
    }

    visitTableFileFormatStoredBy(ctx) {
        return {
            serDeLibrary: getTextFromStringLiteral(ctx),
        };
    }

    visitTableFileFormatStoredAs(ctx) {
        return getStoredAsTable(ctx.tableFileFormatStoredAsFormat().getText());
    }

    visitWhenExists(ctx, funcName, defaultValue = '') {
        return Boolean(ctx[funcName]) && ctx[funcName]() ? this.visit(ctx[funcName]()) : defaultValue;
    }

    visitCreateDatabaseStatement(ctx) {
        const name = this.visit(ctx.identifier());
        const description = this.visitWhenExists(ctx, 'databaseComment');

        return {
            type: CREATE_BUCKET_COMMAND,
            name,
            data: {
                description
            }
        }
    }

    visitDatabaseComment(ctx) {
        return removeSingleDoubleQuotes(ctx.StringLiteral().getText());
    }

    visitSwitchDatabaseStatement(ctx) {
        return {
            type: USE_BUCKET_COMMAND,
            bucketName: this.visit(ctx.identifier())
        }
    }

    dropDatabaseStatement(ctx) {
        return {
            type: REMOVE_BUCKET_COMMAND,
            bucketName: this.visit(ctx.identifier())
        }
    }

    visitCreateIndexStatement(ctx) {
        const {name, database, table, columns, SecIndxHandler} = this.visit(ctx.createIndexMainStatement())
        const SecIndxWithDeferredRebuild = Boolean(ctx.KW_WITH() && ctx.KW_DEFERRED() && ctx.KW_REBUILD());
        const SecIndxProperties = this.visitWhenExists(ctx, 'tableProperties');
        const SecIndxTable = ctx.tableName() ? removeQuotes(ctx.tableName().getText()) : '';
        const SecIndxComments = this.visitWhenExists(ctx, 'tableComment');

        return {
			type: ADD_COLLECTION_LEVEL_INDEX_COMMAND,
			bucketName: database,
			collectionName: table,
			name,
			columns,
            data: _.pickBy({
                SecIndxWithDeferredRebuild,
                SecIndxHandler,
                SecIndxProperties,
                SecIndxTable,
                SecIndxComments,
            }, prop => !_.isEmpty(prop))
		};
    }

    visitCreateIndexMainStatement(ctx) {
        return {
            name: this.visit(ctx.identifier()),
            ...this.visit(ctx.tableName()),
            columns: this.visit(ctx.columnParenthesesList()),
            SecIndxHandler: getTextFromStringLiteral(ctx),
        }
    }

    visitColumnParenthesesList(ctx) {
        return this.visit(ctx.columnNameList());
    }

    visitTableProperties(ctx) {
        return ctx.getText();
    }

    visitDropIndexStatement(ctx) {
        const { database, table } = this.visit(ctx.tableName())
        return {
            type: REMOVE_COLLECTION_LEVEL_INDEX_COMMAND,
            indexName: this.visit(ctx.identifier()),
            collectionName: table,
            bucketName: database,
        }
    }
}

const removeQuotes = (string) => string.replace(/^(`)(.*)\1$/, '$2');

const removeSingleDoubleQuotes = (string = '') => string.replace(/['"]+/g, '');

const getOneOf = (subSchemas, columnName) => {
    return subSchemas.map((subSchema) => {
        return {
            type: 'object',
            properties: {
                [columnName]: subSchema,
            },
        };
    });
};

const getStoredAsTable = (storedAsTable) => {
    switch (storedAsTable.toLowerCase()) {
        case 'textfile':
            return 'textfile';
        case 'sequencefile':
            return 'sequencefile';
        case 'orc':
            return 'ORC';
        case 'parquet':
            return 'Parquet';
        case 'avro':
            return 'Avro';
        case 'rcfile':
            return 'RCfile';
        case 'jsonfile':
            return 'JSONfile';
    }
};

const handleChoices = (field) => {
    const { properties, choices } = Object.keys(field.properties).reduce(
        ({ properties, choices }, key) => {
            const property = field.properties[key];
            if (!property.oneOf || property.type) {
                return {
                    properties: { ...properties, [key]: property },
                    choices,
                };
            }
            return {
                choices: [...choices, getOneOf(property.oneOf, key)],
                properties,
            };
        },
        { properties: {}, choices: [] }
    );
    if (choices.length === 0) {
        return field;
    }

    if (choices.length === 1) {
        return {
            ...field,
            properties,
            oneOf: choices[0],
        };
    }

    return {
        ...field,
        properties,
        allOf: choices.map((choice) => ({ oneOf: choice })),
    };
};

const convertKeysToProperties = (keys = []) => {
    return keys.reduce((properties, key) => {
        return {
            ...properties,
            [key.name]: key.type,
        };
    }, {});
};

const getOrderType = (type) => {
    if (type === 'DESC') {
        return 'descending';
    }

    return 'ascending';
};

const getTextFromStringLiteral = (ctx) => {
    return removeSingleDoubleQuotes(ctx.StringLiteral().getText());
};

const mergeConstraints = (constraints) => {
    return Object.values(constraints || []).reduce((mergedConstraint, constraint) => {
        if (constraint.required) {
            return { ...mergedConstraint, required: true };
        }
        if (constraint.unique) {
            return { ...mergedConstraint, unique: true };
        }
        if (constraint.primaryKey) {
            return { ...mergedConstraint, primaryKey: true };
        }
        if (constraint.default) {
            return { ...mergedConstraint, default: constraint.default };
        }
        if (constraint.check) {
            return { ...mergedConstraint, check: constraint.check };
        }

        return mergedConstraint;
    }, {});
};

module.exports = Visitor;
