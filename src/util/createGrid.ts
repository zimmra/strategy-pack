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
 * Execute a template string as JavaScript and return the resulting card config
 *
 * The template receives the entity id as `$entity`, the current area name as
 * `$area` and a `state_attr` helper for accessing entity attributes. The
 * template must return a valid card configuration object.
 *
 * @param template The template string to execute
 * @param entityData Entity data for variable substitution
 * @param area Current area name
 * @returns Parsed card configuration from the template
 */
const processTemplate = (
    template: string,
    entityData: Record<string, any>,
    area: string,
): LovelaceCardConfig => {
    try {
        const state_attr = (_entity: string, attr: string) => {
            return entityData.attributes ? entityData.attributes[attr] : undefined;
        };

        const fn = new Function(
            "$entity",
            "$area",
            "state_attr",
            `${template}`,
        );

        const result = fn(entityData.entity_id, area, state_attr);

        if (typeof result === "object" && result !== null) {
            return result as LovelaceCardConfig;
        }

        throw new Error("Template did not return an object");
    } catch (error) {
        console.error("Error processing template:", error);
        console.error("Template:", template);
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
