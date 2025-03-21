import { Constructable, FASTElementDefinition } from "@microsoft/fast-element";
import { FoundationElement } from "../foundation-element/foundation-element";
import { Container, DI, Registration } from "../di/di";
import { DesignToken } from "../design-token/design-token";
import { ComponentPresentation } from "./component-presentation";
import type {
    ContextualElementDefinition,
    DesignSystemRegistrationContext,
    ElementDefinitionCallback,
    ElementDefinitionContext,
    ElementDefinitionParams,
} from "./registration-context";
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Indicates what to do with an ambiguous (duplicate) element.
 * @public
 */
export const ElementDisambiguation = Object.freeze({
    /**
     * Skip defining the element but still call the provided callback passed
     * to DesignSystemRegistrationContext.tryDefineElement
     */
    definitionCallbackOnly: null,
    /**
     * Ignore the duplicate element entirely.
     */
    ignoreDuplicate: Symbol(),
});

/**
 * Represents the return values expected from an ElementDisambiguationCallback.
 * @public
 */
export type ElementDisambiguationResult =
    | string
    | typeof ElementDisambiguation.ignoreDuplicate
    | typeof ElementDisambiguation.definitionCallbackOnly;

/**
 * The callback type that is invoked when two elements are trying to define themselves with
 * the same name.
 * @remarks
 * The callback should return either:
 * 1. A string to provide a new name used to disambiguate the element
 * 2. ElementDisambiguation.ignoreDuplicate to ignore the duplicate element entirely
 * 3. ElementDisambiguation.definitionCallbackOnly to skip defining the element but still
 * call the provided callback passed to DesignSystemRegistrationContext.tryDefineElement
 * @public
 */
export type ElementDisambiguationCallback = (
    nameAttempt: string,
    typeAttempt: Constructable,
    existingType: Constructable
) => ElementDisambiguationResult;

const elementTypesByTag = new Map<string, Constructable>();
const elementTagsByType = new Map<Constructable, string>();

/**
 * Represents a configurable design system.
 * @public
 */
export interface DesignSystem {
    /**
     * Registers components and services with the design system and the
     * underlying dependency injection container.
     * @param params - The registries to pass to the design system
     * and the underlying dependency injection container.
     * @public
     */
    register(...params: any[]): DesignSystem;

    /**
     * Configures the prefix to add to each custom element name.
     * @param prefix - The prefix to use for custom elements.
     * @public
     */
    withPrefix(prefix: string): DesignSystem;

    /**
     * Overrides the default Shadow DOM mode for custom elements.
     * @param mode - The Shadow DOM mode to use for custom elements.
     * @public
     */
    withShadowRootMode(mode: ShadowRootMode): DesignSystem;

    /**
     * Provides a custom callback capable of resolving scenarios where
     * two different elements request the same element name.
     * @param callback - The disambiguation callback.
     * @public
     */
    withElementDisambiguation(callback: ElementDisambiguationCallback): DesignSystem;

    /**
     * Overrides the {@link (DesignToken:interface)} root, controlling where
     * {@link (DesignToken:interface)} default value CSS custom properties
     * are emitted.
     *
     * Providing `null` disables automatic DesignToken registration.
     * @param root - the root to register
     * @public
     */
    withDesignTokenRoot(root: HTMLElement | Document | null): DesignSystem;
}

let rootDesignSystem: DesignSystem | null = null;

const designSystemKey = DI.createInterface<DesignSystem>(x =>
    x.cachedCallback(handler => {
        if (rootDesignSystem === null) {
            rootDesignSystem = new DefaultDesignSystem(null, handler);
        }

        return rootDesignSystem;
    })
);

/**
 * An API gateway to design system features.
 * @public
 */
export const DesignSystem = Object.freeze({
    /**
     * Returns the HTML element name that the type is defined as.
     * @param type - The type to lookup.
     * @public
     */
    tagFor(type: Constructable): string {
        return elementTagsByType.get(type)!;
    },

    /**
     * Searches the DOM hierarchy for the design system that is responsible
     * for the provided element.
     * @param element - The element to locate the design system for.
     * @returns The located design system.
     * @public
     */
    responsibleFor(element: HTMLElement): DesignSystem {
        const owned = (element as any).$$designSystem$$ as DesignSystem;

        if (owned) {
            return owned;
        }

        const container = DI.findResponsibleContainer(element);
        return container.get(designSystemKey);
    },

    /**
     * Gets the DesignSystem if one is explicitly defined on the provided element;
     * otherwise creates a design system defined directly on the element.
     * @param element - The element to get or create a design system for.
     * @returns The design system.
     * @public
     */
    getOrCreate(node?: Node): DesignSystem {
        if (!node) {
            if (rootDesignSystem === null) {
                rootDesignSystem = DI.getOrCreateDOMContainer().get(designSystemKey);
            }

            return rootDesignSystem;
        }

        const owned = (node as any).$$designSystem$$ as DesignSystem;

        if (owned) {
            return owned;
        }

        const container = DI.getOrCreateDOMContainer(node);

        if (container.has(designSystemKey, false)) {
            return container.get(designSystemKey);
        } else {
            const system = new DefaultDesignSystem(node, container);
            container.register(Registration.instance(designSystemKey, system));
            return system;
        }
    },
});

function extractTryDefineElementParams(
    params: string | ElementDefinitionParams,
    elementDefinitionType?: Constructable,
    elementDefinitionCallback?: ElementDefinitionCallback
): ElementDefinitionParams {
    if (typeof params === "string") {
        return {
            name: params,
            type: elementDefinitionType!,
            callback: elementDefinitionCallback!,
        };
    } else {
        return params;
    }
}

class DefaultDesignSystem implements DesignSystem {
    private designTokensInitialized: boolean = false;
    private designTokenRoot: HTMLElement | null | undefined;
    private prefix: string = "fast";
    private shadowRootMode: ShadowRootMode | undefined = undefined;
    private disambiguate: ElementDisambiguationCallback = () =>
        ElementDisambiguation.definitionCallbackOnly;

    constructor(private owner: any, private container: Container) {
        if (owner !== null) {
            owner.$$designSystem$$ = this;
        }
    }

    public withPrefix(prefix: string): DesignSystem {
        this.prefix = prefix;
        return this;
    }

    public withShadowRootMode(mode: ShadowRootMode): DesignSystem {
        this.shadowRootMode = mode;
        return this;
    }

    public withElementDisambiguation(
        callback: ElementDisambiguationCallback
    ): DesignSystem {
        this.disambiguate = callback;
        return this;
    }

    public withDesignTokenRoot(root: HTMLElement | null): DesignSystem {
        this.designTokenRoot = root;
        return this;
    }

    public register(...registrations: any[]): DesignSystem {
        const container = this.container;
        const elementDefinitionEntries: ElementDefinitionEntry[] = [];
        const disambiguate = this.disambiguate;
        const shadowRootMode = this.shadowRootMode;
        const context: DesignSystemRegistrationContext = {
            elementPrefix: this.prefix,
            tryDefineElement(
                params: string | ElementDefinitionParams,
                elementDefinitionType?: Constructable,
                elementDefinitionCallback?: ElementDefinitionCallback
            ) {
                const extractedParams = extractTryDefineElementParams(
                    params,
                    elementDefinitionType,
                    elementDefinitionCallback
                );
                const { name, callback, baseClass } = extractedParams;
                let { type } = extractedParams;
                let elementName: string | null = name;

                let typeFoundByName = elementTypesByTag.get(elementName);
                let needsDefine = true;

                while (typeFoundByName) {
                    const result = disambiguate(elementName, type, typeFoundByName);

                    switch (result) {
                        case ElementDisambiguation.ignoreDuplicate:
                            return;
                        case ElementDisambiguation.definitionCallbackOnly:
                            needsDefine = false;
                            typeFoundByName = void 0;
                            break;
                        default:
                            elementName = result as string;
                            typeFoundByName = elementTypesByTag.get(elementName);
                            break;
                    }
                }

                if (needsDefine) {
                    if (elementTagsByType.has(type) || type === FoundationElement) {
                        type = class extends type {};
                    }
                    elementTypesByTag.set(elementName, type);
                    elementTagsByType.set(type, elementName);
                    if (baseClass) {
                        elementTagsByType.set(baseClass, elementName!);
                    }
                }

                elementDefinitionEntries.push(
                    new ElementDefinitionEntry(
                        container,
                        elementName,
                        type,
                        shadowRootMode,
                        callback,
                        needsDefine
                    )
                );
            },
        };

        if (!this.designTokensInitialized) {
            this.designTokensInitialized = true;

            if (this.designTokenRoot !== null) {
                DesignToken.registerRoot(this.designTokenRoot);
            }
        }

        container.registerWithContext(context, ...registrations);

        for (const entry of elementDefinitionEntries) {
            entry.callback(entry);

            if (entry.willDefine && entry.definition !== null) {
                entry.definition.define();
            }
        }

        return this;
    }
}

class ElementDefinitionEntry implements ElementDefinitionContext {
    public definition: FASTElementDefinition | null = null;

    constructor(
        public readonly container: Container,
        public readonly name: string,
        public readonly type: Constructable,
        public shadowRootMode: ShadowRootMode | undefined,
        public readonly callback: ElementDefinitionCallback,
        public readonly willDefine: boolean
    ) {}

    definePresentation(presentation: ComponentPresentation) {
        ComponentPresentation.define(this.name, presentation, this.container);
    }

    defineElement(definition: ContextualElementDefinition) {
        this.definition = new FASTElementDefinition(this.type, {
            ...definition,
            name: this.name,
        });
    }

    tagFor(type: Constructable): string {
        return DesignSystem.tagFor(type)!;
    }
}
/* eslint-enable @typescript-eslint/no-non-null-assertion */
