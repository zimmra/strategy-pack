import { LovelaceCardConfig } from "custom-card-helpers";
import { BaseGridOptions, BaseRowOptions, BaseRowRefOptions, DeepPartial, GridMergeStrategy } from "./types";
import { mergeWith } from "lodash";
import { arrayCustomizer, notNil } from "./helper";
import typia from "typia";

export const mergeConfig = (
    ...conf: Array<DeepPartial<BaseGridOptions> | undefined>
): Omit<BaseGridOptions<BaseRowOptions>, "global" | "gridMergeStrategy"> => {
    const configs = conf?.filter(notNil);
    const localMerge = configs.filter(notNil).reduce((prev, curr) => {
        return { ...prev, ...curr };
    });
    localMerge.global = configs
        .map((c) => c.global)
        .filter(notNil)
        .reduce((prev, curr) => {
            return { ...prev, ...curr };
        });

    //grids are tested later as global will be need to be merged in first
    if (!typia.is<Omit<BaseGridOptions, "grids">>(localMerge)) {
        const state = typia.validate<BaseGridOptions>(localMerge);
        throw Error(state.success ? "Something went wrong. Check config." : JSON.stringify(state.errors));
    }

    const grids =
        localMerge.gridMergeStrategy == GridMergeStrategy.reset
            ? configs
                  .map((c) => c.grids)
                  .filter(notNil)
                  .slice(-1)[0]
            : configs.flatMap((c) => c.grids).filter(notNil);
    const resolvedGrids = grids.reduce(
        (prev, curr) => {
            if (typia.is<BaseRowRefOptions>(curr)) {
                const currRef = curr as BaseRowRefOptions;
                if (!!prev[currRef.gridId]) {
                    prev[currRef.gridId] = {
                        ...prev[currRef.gridId],
                        ...currRef,
                    };
                } else {
                    throw Error(`gridId '${currRef.gridId}' not defined`);
                }
            } else {
                const grid = mergeWith({}, localMerge.global, curr, arrayCustomizer);
                if (!typia.is<BaseRowOptions>(grid)) {
                    const state = typia.validate<BaseRowOptions>(grid);
                    throw Error(state.success ? "Something went wrong. Check config." : JSON.stringify(state.errors));
                }
                prev[grid.id] = grid;
            }
            return prev;
        },
        {} as Record<string, BaseRowOptions>,
    );
    localMerge.grids = Object.values(resolvedGrids).sort((a, b) => (a.position || 0) - (b.position || 0));

    if (!typia.is<BaseGridOptions<BaseRowOptions>>(localMerge)) {
        const state = typia.validate<BaseGridOptions<BaseRowOptions>>(localMerge);
        throw Error(state.success ? "Something went wrong. Check config." : JSON.stringify(state.errors));
    }

    // Ensure grids is never undefined in the return value
    return {
        ...localMerge,
        grids: localMerge.grids || []
    } as Omit<BaseGridOptions<BaseRowOptions>, "global" | "gridMergeStrategy">;
};

/**
 * Process Jinja2-like template strings with entity data
 * @param template The template string to process
 * @param entityData Entity data for variable substitution
 * @param area Current area name
 * @returns Parsed JSON result from the template
 */
const processTemplate = (template: string, entityData: Record<string, any>, area: string): LovelaceCardConfig => {
    try {
        // Replace $entity and $area variables
        let processedTemplate = template
            .replace(/\$entity/g, entityData.entity_id)
            .replace(/\$area/g, area);

        // Basic implementation of simple Jinja2-like syntax
        // Process set statements
        const setRegex = /{%-?\s*set\s+([a-zA-Z0-9_]+)\s*=\s*(.+?)\s*-?%}/g;
        const variables: Record<string, string> = {};
        
        let match;
        while ((match = setRegex.exec(processedTemplate)) !== null) {
            const varName = match[1];
            const varValue = match[2].trim();
            
            // Handle state_attr function
            if (varValue.startsWith('state_attr(')) {
                const attrRegex = /state_attr\(\s*([^,]+)\s*,\s*'([^']+)'\s*\)/;
                const attrMatch = varValue.match(attrRegex);
                if (attrMatch) {
                    const entity = attrMatch[1] === '$entity' ? entityData.entity_id : attrMatch[1];
                    const attrName = attrMatch[2];
                    
                    // For this implementation, we assume attributes are available in entityData
                    if (entityData.attributes && entityData.attributes[attrName] !== undefined) {
                        variables[varName] = JSON.stringify(entityData.attributes[attrName]);
                    } else {
                        variables[varName] = '""';
                    }
                }
            } else if (varValue.startsWith("'") && varValue.endsWith("'")) {
                // String literals
                variables[varName] = varValue;
            } else if (varValue === '$area') {
                variables[varName] = `"${area}"`;
            } else {
                // Variable references
                if (variables[varValue] !== undefined) {
                    variables[varName] = variables[varValue];
                } else {
                    variables[varName] = '""';
                }
            }
            
            // Remove the set statement from the template
            processedTemplate = processedTemplate.replace(match[0], '');
        }
        
        // Process string methods like replace() and trim()
        const methodRegex = /([a-zA-Z0-9_]+)\.replace\(([^,]+),\s*['"]([^'"]*)['"]\)\s*\|\s*trim/g;
        while ((match = methodRegex.exec(processedTemplate)) !== null) {
            const varName = match[1];
            const searchStr = match[2].trim();
            const replaceStr = match[3];
            
            if (variables[varName]) {
                const value = JSON.parse(variables[varName]);
                const searchValue = searchStr === 'current_area' ? area : searchStr;
                const newValue = value.replace(searchValue, replaceStr).trim();
                variables[varName] = `"${newValue}"`;
            }
            
            // Don't remove this from the template yet as it might be part of a larger expression
        }
        
        // Process conditionals (if/elif/endif)
        const ifRegex = /{%-?\s*if\s+(.+?)\s*-?%}([\s\S]*?)(?:{%-?\s*elif\s+(.+?)\s*-?%}([\s\S]*?))*(?:{%-?\s*else\s*-?%}([\s\S]*?))?{%-?\s*endif\s*-?%}/g;
        while ((match = ifRegex.exec(processedTemplate)) !== null) {
            const condition = match[1];
            const ifBlock = match[2];
            // We'd need to extract all elif conditions and blocks, but for this simplified implementation 
            // we'll just handle the if and else cases
            const elseBlock = match[5] || '';

            // Simple condition evaluation - we'll support a few common Home Assistant checks
            let conditionMet = false;
            
            if (condition.includes('in state_attr')) {
                // Handle 'in state_attr' conditions
                const inAttrRegex = /'([^']+)'\s+in\s+state_attr\(\$entity,\s*'([^']+)'\)/;
                const inAttrMatch = condition.match(inAttrRegex);
                if (inAttrMatch) {
                    const value = inAttrMatch[1];
                    const attrName = inAttrMatch[2];
                    
                    if (entityData.attributes && 
                        Array.isArray(entityData.attributes[attrName]) && 
                        entityData.attributes[attrName].includes(value)) {
                        conditionMet = true;
                    } else if (entityData.attributes && 
                        typeof entityData.attributes[attrName] === 'string' && 
                        entityData.attributes[attrName].includes(value)) {
                        conditionMet = true;
                    }
                }
            } else if (condition.includes('in $entity')) {
                // Handle 'in $entity' conditions
                const inEntityRegex = /'([^']+)'\s+in\s+\$entity/;
                const inEntityMatch = condition.match(inEntityRegex);
                if (inEntityMatch) {
                    const value = inEntityMatch[1];
                    if (entityData.entity_id.includes(value)) {
                        conditionMet = true;
                    }
                }
            }
            
            // Replace the entire if block with the appropriate content
            processedTemplate = processedTemplate.replace(
                match[0], 
                conditionMet ? ifBlock : elseBlock
            );
        }
        
        // Replace variable references with their values
        for (const [varName, value] of Object.entries(variables)) {
            const regex = new RegExp(`([^a-zA-Z0-9_])${varName}([^a-zA-Z0-9_])`, 'g');
            processedTemplate = processedTemplate.replace(regex, `$1${value}$2`);
        }

        // Clean the template by removing any extra whitespace and commas
        processedTemplate = processedTemplate
            .replace(/,\s*}}/g, '}}')
            .replace(/,\s*,/g, ',')
            .replace(/\s+/g, ' ')
            .trim();
        
        // Parse the processed template to get a valid JSON object
        return JSON.parse(processedTemplate);
    } catch (error) {
        console.error("Error processing template:", error);
        console.error("Template:", template);
        // Fallback to a basic card if template processing fails
        return {
            type: "markdown",
            content: `Error processing template for ${entityData.entity_id}`,
        };
    }
};

export const createGrid = (
    gridConfig: BaseRowOptions,
    elements: Array<Record<string, any>>,
    replaceConf: { placeholder: string; key: string; replaces?: Array<[string, string]>; area?: string } = { 
        placeholder: "$entity", 
        key: "entity_id" 
    },
): Array<LovelaceCardConfig> => {
    const returnCards: Array<LovelaceCardConfig> = [];
    const gridCards: Array<LovelaceCardConfig> = [];
    elements.forEach((element, index) => {
        let cardConfig;
        const elementCard = (gridConfig.replace || {})[element[replaceConf.key]]?.card;
        const elementTemplate = (gridConfig.replace || {})[element[replaceConf.key]]?.template;
        const gridCard = gridConfig.card;
        const gridTemplate = gridConfig.template;
        
        // Determine what card config to use, prioritizing element-specific templates and cards
        if (elementTemplate) {
            cardConfig = processTemplate(elementTemplate, element, replaceConf.area || '');
        } else if (elementCard) {
            cardConfig = elementCard;
        } else if (gridTemplate) {
            cardConfig = processTemplate(gridTemplate, element, replaceConf.area || '');
        } else {
            cardConfig = gridCard;
        }
        
        if (!cardConfig) {
            console.error("No card configuration found for element:", element);
            return;
        }
        
        // Handle standard variable replacements for non-template cards
        if (elementTemplate === undefined && gridTemplate === undefined) {
            const replaces = Object.fromEntries([
                ...(replaceConf.replaces || []),
                ["$index", index.toString()],
                [replaceConf.placeholder, element[replaceConf.key] as string],
            ]);
            
            const resolvedCard = Object.entries(cardConfig)
                .filter(([_key, val]) => {
                    const stringVal = JSON.stringify(val);
                    return Object.keys(replaces).some((replace) => stringVal.includes(replace));
                })
                .map(([key, val]) => {
                    const stringVal = JSON.stringify(val);
                    const newStringVal = Object.entries(replaces).reduce((prev, curr) => {
                        return prev.replaceAll(curr[0], curr[1]);
                    }, stringVal);
                    return [key, JSON.parse(newStringVal)];
                });
            
            cardConfig = {
                ...cardConfig,
                ...Object.fromEntries(resolvedCard),
            };
        }
        
        gridCards.push({
            type: "vertical-stack",
            cards: [cardConfig],
        });
    });
    
    if (gridCards.length > 0) {
        if (gridConfig.title) {
            returnCards.push({
                type: "markdown",
                text_only: true,
                content: "## " + gridConfig.title,
            });
        }
        returnCards.push({
            type: "custom:layout-card",
            layout_type: "custom:grid-layout",
            layout: {
                "grid-template-rows": "auto",
                "grid-template-columns": `repeat(auto-fit, minmax(${gridConfig.minCardWidth}px, 1fr))`,
            },
            cards: gridCards,
        });
    }
    return returnCards;
};
