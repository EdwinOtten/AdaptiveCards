﻿import * as Enums from "./enums";
import * as Shared from "./shared";
import * as Utils from "./utils";
import * as HostConfig from "./host-config";
import * as TextFormatters from "./text-formatters";

function invokeSetCollection(action: Action, collection: ActionCollection) {
	if (action) {
		// Closest emulation of "internal" in TypeScript.
		action["setCollection"](collection);
	}
}

function isActionAllowed(action: Action, forbiddenActionTypes: Array<string>): boolean {
	if (forbiddenActionTypes) {
		for (var i = 0; i < forbiddenActionTypes.length; i++) {
			if (action.getJsonTypeName() === forbiddenActionTypes[i]) {
				return false;
			}
		}
	}

	return true;
}

function createCardObjectInstance<T extends ICardObject>(
	parent: CardElement,
	json: any,
	createInstanceCallback: (typeName: string) => T,
	createValidationErrorCallback: (typeName: string) => HostConfig.IValidationError,
	errors: Array<HostConfig.IValidationError>): T {
	let result: T = null;

	if (json && typeof json === "object") {
		let tryToFallback = false;
		let typeName = json["type"];

		result = createInstanceCallback(typeName);

		if (!result) {
			tryToFallback = true;

			raiseParseError(createValidationErrorCallback(typeName), errors);
		}
		else {
			result.setParent(parent);
			result.parse(json);

			tryToFallback = result.shouldFallback();
		}

		if (tryToFallback) {
			let fallback = json["fallback"];

			if (!fallback) {
				parent.setShouldFallback(true);
			}
			if (typeof fallback === "string" && fallback.toLowerCase() === "drop") {
				result = null;
			}
			else if (typeof fallback === "object") {
				result = createCardObjectInstance<T>(
					parent,
					fallback,
					createInstanceCallback,
					createValidationErrorCallback,
					errors);
			}
		}
	}

	return result;
}

export function createActionInstance(
	parent: CardElement,
	json: any,
	errors: Array<HostConfig.IValidationError>): Action {
	return createCardObjectInstance<Action>(
		parent,
		json,
		(typeName: string) => { return AdaptiveCard.actionTypeRegistry.createInstance(typeName); },
		(typeName: string) => {
			return {
				error: Enums.ValidationError.UnknownActionType,
				message: "Unknown action type: " + typeName + ". Attempting to fall back."
			}
		},
		errors);
}

export function createElementInstance(
	parent: CardElement,
	json: any,
	errors: Array<HostConfig.IValidationError>): CardElement {
	return createCardObjectInstance<CardElement>(
		parent,
		json,
		(typeName: string) => { return AdaptiveCard.elementTypeRegistry.createInstance(typeName); },
		(typeName: string) => {
			return {
				error: Enums.ValidationError.UnknownElementType,
				message: "Unknown element type: " + typeName + ". Attempting to fall back."
			}
		},
		errors);
}

export interface ICardObject {
	shouldFallback(): boolean;
	setParent(parent: CardElement);
	parse(json: any);
}

export type CardElementHeight = "auto" | "stretch";

export abstract class CardElement implements ICardObject {
	private _shouldFallback: boolean = false;
	private _lang: string = undefined;
	private _hostConfig?: HostConfig.HostConfig = null;
	private _parent: CardElement = null;
	private _renderedElement: HTMLElement = null;
	private _separatorElement: HTMLElement = null;
	private _isVisible: boolean = true;
	private _truncatedDueToOverflow: boolean = false;
	private _defaultRenderedElementDisplayMode: string = null;
	private _padding: Shared.PaddingDefinition = null;

	private internalRenderSeparator(): HTMLElement {
		let renderedSeparator = Utils.renderSeparation(
			{
				spacing: this.hostConfig.getEffectiveSpacing(this.spacing),
				lineThickness: this.separator ? this.hostConfig.separator.lineThickness : null,
				lineColor: this.separator ? this.hostConfig.separator.lineColor : null
			},
			this.separatorOrientation);

		if (AdaptiveCard.alwaysBleedSeparators && renderedSeparator && this.separatorOrientation == Enums.Orientation.Horizontal) {
			let parentContainer = this.getParentContainer();

			if (parentContainer && parentContainer.getEffectivePadding()) {
				let parentPhysicalPadding = this.hostConfig.paddingDefinitionToSpacingDefinition(parentContainer.getEffectivePadding());

				renderedSeparator.style.marginLeft = "-" + parentPhysicalPadding.left + "px";
				renderedSeparator.style.marginRight = "-" + parentPhysicalPadding.right + "px";
			}
		}

		return renderedSeparator;
	}

	private updateRenderedElementVisibility() {
		if (this._renderedElement) {
			this._renderedElement.style.display = this._isVisible ? this._defaultRenderedElementDisplayMode : "none";
		}

		if (this._separatorElement) {
			if (this.parent && this.parent.isFirstElement(this)) {
				this._separatorElement.style.display = "none";
			}
			else {
				this._separatorElement.style.display = this._isVisible ? this._defaultRenderedElementDisplayMode : "none";
			}
		}
	}

	private hideElementDueToOverflow() {
		if (this._renderedElement && this._isVisible) {
			this._renderedElement.style.visibility = 'hidden';
			this._isVisible = false;
			raiseElementVisibilityChangedEvent(this, false);
		}
	}

	private showElementHiddenDueToOverflow() {
		if (this._renderedElement && !this._isVisible) {
			this._renderedElement.style.visibility = null;
			this._isVisible = true;
			raiseElementVisibilityChangedEvent(this, false);
		}
	}

	// Marked private to emulate internal access
	private handleOverflow(maxHeight: number) {
		if (this.isVisible || this.isHiddenDueToOverflow()) {
			var handled = this.truncateOverflow(maxHeight);

			// Even if we were unable to truncate the element to fit this time,
			// it still could have been previously truncated
			this._truncatedDueToOverflow = handled || this._truncatedDueToOverflow;

			if (!handled) {
				this.hideElementDueToOverflow();
			}
			else if (handled && !this._isVisible) {
				this.showElementHiddenDueToOverflow();
			}
		}
	}

	// Marked private to emulate internal access
	private resetOverflow(): boolean {
		var sizeChanged = false;

		if (this._truncatedDueToOverflow) {
			this.undoOverflowTruncation();
			this._truncatedDueToOverflow = false;
			sizeChanged = true;
		}

		if (this.isHiddenDueToOverflow) {
			this.showElementHiddenDueToOverflow();
		}

		return sizeChanged;
	}

	protected createPlaceholderElement(): HTMLElement {
		var element = document.createElement("div");
		element.style.border = "1px dashed #DDDDDD";
		element.style.padding = "4px";
		element.style.minHeight = "32px";
		element.style.fontSize = "10px";
		element.innerText = "Empty " + this.getJsonTypeName();

		return element;
	}

	protected adjustRenderedElementSize(renderedElement: HTMLElement) {
		if (this.height === "auto") {
			renderedElement.style.flex = "0 0 auto";
		}
		else {
			renderedElement.style.flex = "1 1 auto";
		}

		if (this.minPixelHeight) {
			renderedElement.style.minHeight = this.minPixelHeight + "px";
		}
	}

	protected abstract internalRender(): HTMLElement;

    /*
     * Called when this element overflows the bottom of the card.
     * maxHeight will be the amount of space still available on the card (0 if
     * the element is fully off the card).
     */
	protected truncateOverflow(maxHeight: number): boolean {
		// Child implementations should return true if the element handled
		// the truncation request such that its content fits within maxHeight,
		// false if the element should fall back to being hidden
		return false;
	}

    /*
     * This should reverse any changes performed in truncateOverflow().
     */
	protected undoOverflowTruncation() { }

	protected isDesignMode(): boolean {
		var rootElement = this.getRootElement();

		return rootElement instanceof AdaptiveCard && rootElement.designMode;
	}

	protected getDefaultPadding(): Shared.PaddingDefinition {
		return new Shared.PaddingDefinition();
	}

	protected getHasBackground(): boolean {
		return false;
	}

	protected get useDefaultSizing(): boolean {
		return true;
	}

	protected get allowCustomPadding(): boolean {
		return true;
	}

	protected get separatorOrientation(): Enums.Orientation {
		return Enums.Orientation.Horizontal;
	}

	protected getPadding(): Shared.PaddingDefinition {
		return this._padding;
	}

	protected setPadding(value: Shared.PaddingDefinition) {
		this._padding = value;
	}

	readonly requires = new HostConfig.HostCapabilities();

	id: string;
	speak: string;
	horizontalAlignment?: Enums.HorizontalAlignment = null;
	spacing: Enums.Spacing = Enums.Spacing.Default;
	separator: boolean = false;
	customCssSelector: string = null;
	height: CardElementHeight = "auto";
	minPixelHeight?: number = null;

	abstract getJsonTypeName(): string;
	abstract renderSpeech(): string;

	toJSON() {
		let result = {};

		Utils.setProperty(result, "type", this.getJsonTypeName());
		Utils.setProperty(result, "id", this.id);

		if (this.horizontalAlignment !== null) {
			Utils.setEnumProperty(Enums.HorizontalAlignment, result, "horizontalAlignment", this.horizontalAlignment);
		}

		Utils.setEnumProperty(Enums.Spacing, result, "spacing", this.spacing, Enums.Spacing.Default);
		Utils.setProperty(result, "separator", this.separator, false);
		Utils.setProperty(result, "height", this.height, "auto");

		if (this.minPixelHeight) {
			Utils.setProperty(result, "minHeight", this.minPixelHeight + "px");
		}

		return result;
	}

	setParent(value: CardElement) {
		this._parent = value;
	}

	getForbiddenElementTypes(): Array<string> {
		return null;
	}

	getForbiddenActionTypes(): Array<any> {
		return null;
	}

	getImmediateSurroundingPadding(
		result: Shared.PaddingDefinition,
		processTop: boolean = true,
		processRight: boolean = true,
		processBottom: boolean = true,
		processLeft: boolean = true) {
		if (this.parent) {
			let doProcessTop = processTop && this.parent.isFirstElement(this);
			let doProcessRight = processRight && this.parent.isRightMostElement(this);
			let doProcessBottom = processBottom && this.parent.isLastElement(this);
			let doProcessLeft = processLeft && this.parent.isLeftMostElement(this);

			let effectivePadding = this.parent.getEffectivePadding();

			if (effectivePadding) {
				if (doProcessTop) {
					result.top = effectivePadding.top;
				}

				if (doProcessRight) {
					result.right = effectivePadding.right;
				}

				if (doProcessBottom) {
					result.bottom = effectivePadding.bottom;
				}

				if (doProcessLeft) {
					result.left = effectivePadding.left;
				}
			}

			if (doProcessTop || doProcessRight || doProcessBottom || doProcessLeft) {
				this.parent.getImmediateSurroundingPadding(
					result,
					doProcessTop,
					doProcessRight,
					doProcessBottom,
					doProcessLeft);
			}
		}
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		raiseParseElementEvent(this, json, errors);

		this.requires.parse(json["requires"], errors);
		this.id = json["id"];
		this.isVisible = Utils.parseBoolProperty(json["isVisible"], this.isVisible);
		this.speak = json["speak"];
		this.horizontalAlignment = Utils.getEnumValueOrDefault(Enums.HorizontalAlignment, json["horizontalAlignment"], null);

		this.spacing = Utils.getEnumValueOrDefault(Enums.Spacing, json["spacing"], Enums.Spacing.Default);
		this.separator = Utils.parseBoolProperty(json["separator"], this.separator);

		let jsonSeparation = json["separation"];

		if (jsonSeparation !== undefined) {
			if (jsonSeparation === "none") {
				this.spacing = Enums.Spacing.None;
				this.separator = false;
			}
			else if (jsonSeparation === "strong") {
				this.spacing = Enums.Spacing.Large;
				this.separator = true;
			}
			else if (jsonSeparation === "default") {
				this.spacing = Enums.Spacing.Default;
				this.separator = false;
			}

			raiseParseError(
				{
					error: Enums.ValidationError.Deprecated,
					message: "The \"separation\" property is deprecated and will be removed. Use the \"spacing\" and \"separator\" properties instead."
				},
				errors
			);
		}

		let jsonHeight = json["height"];

		if (jsonHeight === "auto" || jsonHeight === "stretch") {
			this.height = jsonHeight;
		}

		let jsonMinHeight = json["minHeight"];

		if (jsonMinHeight && typeof jsonMinHeight === "string") {
			let isValid = false;

			try {
				let size = Shared.SizeAndUnit.parse(jsonMinHeight, true);

				if (size.unit == Enums.SizeUnit.Pixel) {
					this.minPixelHeight = size.physicalSize;

					isValid = true;
				}
			}
			catch {
				// Do nothing. A parse error is emitted below
			}

			if (!isValid) {
				raiseParseError(
					{
						error: Enums.ValidationError.InvalidPropertyValue,
						message: "Invalid \"minHeight\" value: " + jsonMinHeight
					},
					errors
				);
			}
		}
	}

	getActionCount(): number {
		return 0;
	}

	getActionAt(index: number): Action {
		throw new Error("Index out of range.");
	}

	validate(): Array<HostConfig.IValidationError> {
		return [];
	}

	remove(): boolean {
		if (this.parent && this.parent instanceof CardElementContainer) {
			return this.parent.removeItem(this);
		}

		return false;
	}

	render(): HTMLElement {
		this._renderedElement = this.internalRender();
		this._separatorElement = this.internalRenderSeparator();

		if (this._renderedElement) {
			if (this.customCssSelector) {
				this._renderedElement.classList.add(this.customCssSelector);
			}

			this._renderedElement.style.boxSizing = "border-box";
			this._defaultRenderedElementDisplayMode = this._renderedElement.style.display;

			this.adjustRenderedElementSize(this._renderedElement);
			this.updateLayout(false);
		}
		else if (this.isDesignMode()) {
			this._renderedElement = this.createPlaceholderElement();
		}

		return this._renderedElement;
	}

	updateLayout(processChildren: boolean = true) {
		this.updateRenderedElementVisibility();
	}

	indexOf(cardElement: CardElement): number {
		return -1;
	}

	isRendered(): boolean {
		return this._renderedElement && this._renderedElement.offsetHeight > 0;
	}

	isFirstElement(element: CardElement): boolean {
		return true;
	}

	isLastElement(element: CardElement): boolean {
		return true;
	}

	isAtTheVeryLeft(): boolean {
		return this.parent ? this.parent.isLeftMostElement(this) && this.parent.isAtTheVeryLeft() : true;
	}

	isAtTheVeryRight(): boolean {
		return this.parent ? this.parent.isRightMostElement(this) && this.parent.isAtTheVeryRight() : true;
	}

	isAtTheVeryTop(): boolean {
		return this.parent ? this.parent.isFirstElement(this) && this.parent.isAtTheVeryTop() : true;
	}

	isAtTheVeryBottom(): boolean {
		return this.parent ? this.parent.isLastElement(this) && this.parent.isAtTheVeryBottom() : true;
	}

	isBleedingAtTop(): boolean {
		return false;
	}

	isBleedingAtBottom(): boolean {
		return false;
	}

	isLeftMostElement(element: CardElement): boolean {
		return true;
	}

	isRightMostElement(element: CardElement): boolean {
		return true;
	}

	isHiddenDueToOverflow(): boolean {
		return this._renderedElement && this._renderedElement.style.visibility == 'hidden';
	}

	getRootElement(): CardElement {
		var rootElement: CardElement = this;

		while (rootElement.parent) {
			rootElement = rootElement.parent;
		}

		return rootElement;
	}

	getParentContainer(): Container {
		var currentElement: CardElement = this.parent;

		while (currentElement) {
			if (currentElement instanceof Container) {
				return <Container>currentElement;
			}

			currentElement = currentElement.parent;
		}

		return null;
	}

	getAllInputs(): Array<Input> {
		return [];
	}

	getResourceInformation(): Array<Shared.IResourceInformation> {
		return [];
	}

	getElementById(id: string): CardElement {
		return this.id === id ? this : null;
	}

	getActionById(id: string): Action {
		return null;
	}

	shouldFallback(): boolean {
		return this._shouldFallback || !this.requires.areAllMet(this.hostConfig.hostCapabilities);
	}

	setShouldFallback(value: boolean) {
		this._shouldFallback = value;
	}

	getEffectivePadding(): Shared.PaddingDefinition {
		let padding = this.getPadding();

		return (padding && this.allowCustomPadding) ? padding : this.getDefaultPadding();
	}

	get lang(): string {
		if (this._lang) {
			return this._lang;
		}
		else {
			if (this.parent) {
				return this.parent.lang;
			}
			else {
				return undefined;
			}
		}
	}

	set lang(value: string) {
		if (value && value != "") {
			var regEx = /^[a-z]{2,3}$/ig;

			var matches = regEx.exec(value);

			if (!matches) {
				throw new Error("Invalid language identifier: " + value);
			}
		}

		this._lang = value;
	}

	get hostConfig(): HostConfig.HostConfig {
		if (this._hostConfig) {
			return this._hostConfig;
		}
		else {
			if (this.parent) {
				return this.parent.hostConfig;
			}
			else {
				return defaultHostConfig;
			}
		}
	}

	set hostConfig(value: HostConfig.HostConfig) {
		this._hostConfig = value;
	}

	get index(): number {
		if (this.parent) {
			return this.parent.indexOf(this);
		}
		else {
			return 0;
		}
	}

	get isInteractive(): boolean {
		return false;
	}

	get isStandalone(): boolean {
		return true;
	}

	get parent(): CardElement {
		return this._parent;
	}

	get isVisible(): boolean {
		return this._isVisible;
	}

	get hasVisibleSeparator(): boolean {
		var parentContainer = this.getParentContainer();

		if (parentContainer) {
			return this.separatorElement && !parentContainer.isFirstElement(this);
		}
		else {
			return false;
		}
	}

	set isVisible(value: boolean) {
		// If the element is going to be hidden, reset any changes that were due
		// to overflow truncation (this ensures that if the element is later
		// un-hidden it has the right content)
		if (AdaptiveCard.useAdvancedCardBottomTruncation && !value) {
			this.undoOverflowTruncation();
		}

		if (this._isVisible != value) {
			this._isVisible = value;

			this.updateRenderedElementVisibility();

			if (this._renderedElement) {
				raiseElementVisibilityChangedEvent(this);
			}
		}
	}

	get renderedElement(): HTMLElement {
		return this._renderedElement;
	}

	get separatorElement(): HTMLElement {
		return this._separatorElement;
	}
}

export class TextBlock extends CardElement {
	private _computedLineHeight: number;
	private _originalInnerHtml: string;
	private _text: string;
	private _processedText: string = null;
	private _treatAsPlainText: boolean = true;
	private _selectAction: Action = null;
	private _effectiveStyleDefinition: HostConfig.ContainerStyleDefinition = null;

	private restoreOriginalContent() {
		var maxHeight = this.maxLines
			? (this._computedLineHeight * this.maxLines) + 'px'
			: null;

		this.renderedElement.style.maxHeight = maxHeight;
		this.renderedElement.innerHTML = this._originalInnerHtml;
	}

	private truncateIfSupported(maxHeight: number): boolean {
		// For now, only truncate TextBlocks that contain just a single
		// paragraph -- since the maxLines calculation doesn't take into
		// account Markdown lists
		var children = this.renderedElement.children;
		var isTextOnly = !children.length;

		var truncationSupported = isTextOnly || children.length == 1
			&& (<HTMLElement>children[0]).tagName.toLowerCase() == 'p';

		if (truncationSupported) {
			var element = isTextOnly
				? this.renderedElement
				: <HTMLElement>children[0];

			Utils.truncate(element, maxHeight, this._computedLineHeight);
			return true;
		}

		return false;
	}

	private getEffectiveStyleDefinition() {
		if (!this._effectiveStyleDefinition) {
			this._effectiveStyleDefinition = this.hostConfig.containerStyles.default;

			let parentContainer = this.getParentContainer();

			while (parentContainer) {
				if (parentContainer.style) {
					this._effectiveStyleDefinition = this.hostConfig.containerStyles.getStyleByName(parentContainer.style);

					break;
				}

				parentContainer = parentContainer.getParentContainer();
			}
		}

		return this._effectiveStyleDefinition;
	}

	protected getRenderedDomElementType(): string {
		return "div";
	}

	protected internalRender(): HTMLElement {
		this._effectiveStyleDefinition = null;
		this._processedText = null;

		if (!Utils.isNullOrEmpty(this.text)) {
			let hostConfig = this.hostConfig;

			let element = document.createElement(this.getRenderedDomElementType());
			element.classList.add(hostConfig.makeCssClassName("ac-textBlock"));
			element.style.overflow = "hidden";

			this.applyStylesTo(element);

			if (this.selectAction) {
				element.onclick = (e) => {
					this.selectAction.execute();

					e.cancelBubble = true;
				}
			}

			if (!this._processedText) {
				this._treatAsPlainText = true;

				let formattedText = TextFormatters.formatText(this.lang, this.text);

				if (this.useMarkdown) {
					if (AdaptiveCard.allowMarkForTextHighlighting) {
						formattedText = formattedText.replace(/<mark>/g, "===").replace(/<\/mark>/g, "/==");
					}

					let markdownProcessingResult = AdaptiveCard.applyMarkdown(formattedText);

					if (markdownProcessingResult.didProcess && markdownProcessingResult.outputHtml) {
						this._processedText = markdownProcessingResult.outputHtml;
						this._treatAsPlainText = false;

						// Only process <mark> tag if markdown processing was applied because
						// markdown processing is also responsible for sanitizing the input string
						if (AdaptiveCard.allowMarkForTextHighlighting) {
							let markStyle: string = "";
							let effectiveStyle = this.getEffectiveStyleDefinition();

							if (effectiveStyle.highlightBackgroundColor) {
								markStyle += "background-color: " + effectiveStyle.highlightBackgroundColor + ";";
							}

							if (effectiveStyle.highlightForegroundColor) {
								markStyle += "color: " + effectiveStyle.highlightForegroundColor + ";";
							}

							if (!Utils.isNullOrEmpty(markStyle)) {
								markStyle = 'style="' + markStyle + '"';
							}

							this._processedText = this._processedText.replace(/===/g, "<mark " + markStyle + ">").replace(/\/==/g, "</mark>");
						}
					} else {
						this._processedText = formattedText;
						this._treatAsPlainText = true;
					}
				}
				else {
					this._processedText = formattedText;
					this._treatAsPlainText = true;
				}
			}

			if (this._treatAsPlainText) {
				element.innerText = this._processedText;
			}
			else {
				element.innerHTML = this._processedText;
			}

			if (element.firstElementChild instanceof HTMLElement) {
				let firstElementChild = <HTMLElement>element.firstElementChild;
				firstElementChild.style.marginTop = "0px";
				firstElementChild.style.width = "100%";

				if (!this.wrap) {
					firstElementChild.style.overflow = "hidden";
					firstElementChild.style.textOverflow = "ellipsis";
				}
			}

			if (element.lastElementChild instanceof HTMLElement) {
				(<HTMLElement>element.lastElementChild).style.marginBottom = "0px";
			}

			let anchors = element.getElementsByTagName("a");

			for (let i = 0; i < anchors.length; i++) {
				let anchor = <HTMLAnchorElement>anchors[i];
				anchor.classList.add(this.hostConfig.makeCssClassName("ac-anchor"));
				anchor.target = "_blank";
				anchor.onclick = (e) => {
					if (raiseAnchorClickedEvent(this, e.target as HTMLAnchorElement)) {
						e.preventDefault();
					}
				}
			}

			if (this.wrap) {
				element.style.wordWrap = "break-word";

				if (this.maxLines > 0) {
					element.style.maxHeight = (this._computedLineHeight * this.maxLines) + "px";
					element.style.overflow = "hidden";
				}
			}
			else {
				element.style.whiteSpace = "nowrap";
				element.style.textOverflow = "ellipsis";
			}

			if (AdaptiveCard.useAdvancedTextBlockTruncation || AdaptiveCard.useAdvancedCardBottomTruncation) {
				this._originalInnerHtml = element.innerHTML;
			}

			if (this.selectAction != null && hostConfig.supportsInteractivity) {
				element.tabIndex = 0
				element.setAttribute("role", "button");
				element.setAttribute("aria-label", this.selectAction.title);
				element.classList.add(hostConfig.makeCssClassName("ac-selectable"));
			}

			return element;
		}
		else {
			return null;
		}
	}

	protected truncateOverflow(maxHeight: number): boolean {
		if (maxHeight >= this._computedLineHeight) {
			return this.truncateIfSupported(maxHeight);
		}

		return false;
	}

	protected undoOverflowTruncation() {
		this.restoreOriginalContent();

		if (AdaptiveCard.useAdvancedTextBlockTruncation && this.maxLines) {
			var maxHeight = this._computedLineHeight * this.maxLines;
			this.truncateIfSupported(maxHeight);
		}
	}

	size: Enums.TextSize = Enums.TextSize.Default;
	weight: Enums.TextWeight = Enums.TextWeight.Default;
	color: Enums.TextColor = Enums.TextColor.Default;
	isSubtle: boolean = false;
	wrap: boolean = false;
	maxLines: number;
	useMarkdown: boolean = true;

	toJSON() {
		let result = super.toJSON();

		Utils.setEnumProperty(Enums.TextSize, result, "size", this.size, Enums.TextSize.Default);
		Utils.setEnumProperty(Enums.TextWeight, result, "weight", this.weight, Enums.TextWeight.Default);
		Utils.setEnumProperty(Enums.TextColor, result, "color", this.color, Enums.TextColor.Default);
		Utils.setProperty(result, "text", this.text);
		Utils.setProperty(result, "isSubtle", this.isSubtle, false);
		Utils.setProperty(result, "wrap", this.wrap, false);
		Utils.setProperty(result, "maxLines", this.maxLines, 0);

		return result;
	}

	applyStylesTo(targetElement: HTMLElement) {
		if (this.hostConfig.fontFamily) {
			targetElement.style.fontFamily = this.hostConfig.fontFamily;
		}

		let parentContainer = this.getParentContainer();
		let isRtl = parentContainer ? parentContainer.isRtl() : false;

		switch (this.horizontalAlignment) {
			case Enums.HorizontalAlignment.Center:
				targetElement.style.textAlign = "center";
				break;
			case Enums.HorizontalAlignment.Right:
				targetElement.style.textAlign = isRtl ? "left" : "right";
				break;
			default:
				targetElement.style.textAlign = isRtl ? "right" : "left";
				break;
		}

		var fontSize: number;

		switch (this.size) {
			case Enums.TextSize.Small:
				fontSize = this.hostConfig.fontSizes.small;
				break;
			case Enums.TextSize.Medium:
				fontSize = this.hostConfig.fontSizes.medium;
				break;
			case Enums.TextSize.Large:
				fontSize = this.hostConfig.fontSizes.large;
				break;
			case Enums.TextSize.ExtraLarge:
				fontSize = this.hostConfig.fontSizes.extraLarge;
				break;
			default:
				fontSize = this.hostConfig.fontSizes.default;
				break;
		}

		if (this.hostConfig.lineHeights) {
			switch (this.size) {
				case Enums.TextSize.Small:
					this._computedLineHeight = this.hostConfig.lineHeights.small;
					break;
				case Enums.TextSize.Medium:
					this._computedLineHeight = this.hostConfig.lineHeights.medium;
					break;
				case Enums.TextSize.Large:
					this._computedLineHeight = this.hostConfig.lineHeights.large;
					break;
				case Enums.TextSize.ExtraLarge:
					this._computedLineHeight = this.hostConfig.lineHeights.extraLarge;
					break;
				default:
					this._computedLineHeight = this.hostConfig.lineHeights.default;
					break;
			}
		}
		else {
			// Looks like 1.33 is the magic number to compute line-height
			// from font size.
			this._computedLineHeight = fontSize * 1.33;
		}

		targetElement.style.fontSize = fontSize + "px";
		targetElement.style.lineHeight = this._computedLineHeight + "px";

		let styleDefinition = this.getEffectiveStyleDefinition();

		let actualTextColor = this.color ? this.color : Enums.TextColor.Default;
		let colorDefinition: HostConfig.TextColorDefinition;

		switch (actualTextColor) {
			case Enums.TextColor.Accent:
				colorDefinition = styleDefinition.foregroundColors.accent;
				break;
			case Enums.TextColor.Dark:
				colorDefinition = styleDefinition.foregroundColors.dark;
				break;
			case Enums.TextColor.Light:
				colorDefinition = styleDefinition.foregroundColors.light;
				break;
			case Enums.TextColor.Good:
				colorDefinition = styleDefinition.foregroundColors.good;
				break;
			case Enums.TextColor.Warning:
				colorDefinition = styleDefinition.foregroundColors.warning;
				break;
			case Enums.TextColor.Attention:
				colorDefinition = styleDefinition.foregroundColors.attention;
				break;
			default:
				colorDefinition = styleDefinition.foregroundColors.default;
				break;
		}

		targetElement.style.color = Utils.stringToCssColor(this.isSubtle ? colorDefinition.subtle : colorDefinition.default);

		let fontWeight: number;

		switch (this.weight) {
			case Enums.TextWeight.Lighter:
				fontWeight = this.hostConfig.fontWeights.lighter;
				break;
			case Enums.TextWeight.Bolder:
				fontWeight = this.hostConfig.fontWeights.bolder;
				break;
			default:
				fontWeight = this.hostConfig.fontWeights.default;
				break;
		}

		targetElement.style.fontWeight = fontWeight.toString();
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.text = json["text"];

		var sizeString = json["size"];

		if (sizeString && typeof sizeString === "string" && sizeString.toLowerCase() === "normal") {
			this.size = Enums.TextSize.Default;

			raiseParseError(
				{
					error: Enums.ValidationError.Deprecated,
					message: "The TextBlock.size value \"normal\" is deprecated and will be removed. Use \"default\" instead."
				},
				errors
			);
		}
		else {
			this.size = Utils.getEnumValueOrDefault(Enums.TextSize, sizeString, this.size);
		}

		var weightString = json["weight"];

		if (weightString && typeof weightString === "string" && weightString.toLowerCase() === "normal") {
			this.weight = Enums.TextWeight.Default;

			raiseParseError(
				{
					error: Enums.ValidationError.Deprecated,
					message: "The TextBlock.weight value \"normal\" is deprecated and will be removed. Use \"default\" instead."
				},
				errors
			);
		}
		else {
			this.weight = Utils.getEnumValueOrDefault(Enums.TextWeight, weightString, this.weight);
		}

		this.color = Utils.getEnumValueOrDefault(Enums.TextColor, json["color"], this.color);
		this.isSubtle = Utils.parseBoolProperty(json["isSubtle"], this.isSubtle);
		this.wrap = Utils.parseBoolProperty(json["wrap"], this.wrap);

		if (typeof json["maxLines"] === "number") {
			this.maxLines = json["maxLines"];
		}
	}

	getJsonTypeName(): string {
		return "TextBlock";
	}

	renderSpeech(): string {
		if (this.speak != null)
			return this.speak + '\n';

		if (this.text)
			return '<s>' + this.text + '</s>\n';

		return null;
	}

	updateLayout(processChildren: boolean = false) {
		super.updateLayout(processChildren);

		if (AdaptiveCard.useAdvancedTextBlockTruncation && this.maxLines && this.isRendered()) {
			// Reset the element's innerHTML in case the available room for
			// content has increased
			this.restoreOriginalContent();
			var maxHeight = this._computedLineHeight * this.maxLines;
			this.truncateIfSupported(maxHeight);
		}
	}

	get text(): string {
		return this._text;
	}

	set text(value: string) {
		if (this._text != value) {
			this._text = value;

			this._processedText = null;
		}
	}

	get selectAction(): Action {
		return this._selectAction;
	}

	set selectAction(value: Action) {
		this._selectAction = value;

		if (this._selectAction) {
			this._selectAction.setParent(this);
		}
	}
}

class Label extends TextBlock {
	protected getRenderedDomElementType(): string {
		return "label";
	}

	protected internalRender(): HTMLElement {
		let renderedElement = <HTMLLabelElement>super.internalRender();

		if (!Utils.isNullOrEmpty(this.forElementId)) {
			renderedElement.htmlFor = this.forElementId;
		}

		return renderedElement;
	}

	forElementId: string;
}

export class Fact {
	name: string;
	value: string;
	speak: string;

	constructor(name: string = undefined, value: string = undefined) {
		this.name = name;
		this.value = value;
	}

	toJSON() {
		return { title: this.name, value: this.value };
	}

	renderSpeech(): string {
		if (this.speak != null) {
			return this.speak + '\n';
		}

		return '<s>' + this.name + ' ' + this.value + '</s>\n';
	}
}

export class FactSet extends CardElement {
	protected get useDefaultSizing(): boolean {
		return false;
	}

	protected internalRender(): HTMLElement {
		let element: HTMLElement = null;
		let hostConfig = this.hostConfig;

		if (this.facts.length > 0) {
			element = document.createElement("table");
			element.style.borderWidth = "0px";
			element.style.borderSpacing = "0px";
			element.style.borderStyle = "none";
			element.style.borderCollapse = "collapse";
			element.style.display = "block";
			element.style.overflow = "hidden";
			element.classList.add(hostConfig.makeCssClassName("ac-factset"));

			for (let i = 0; i < this.facts.length; i++) {
				let trElement = document.createElement("tr");

				if (i > 0) {
					trElement.style.marginTop = this.hostConfig.factSet.spacing + "px";
				}

				// Title column
				let tdElement = document.createElement("td");
				tdElement.style.padding = "0";
				tdElement.classList.add(hostConfig.makeCssClassName("ac-fact-title"));

				if (this.hostConfig.factSet.title.maxWidth) {
					tdElement.style.maxWidth = this.hostConfig.factSet.title.maxWidth + "px";
				}

				tdElement.style.verticalAlign = "top";

				let textBlock = new TextBlock();
				textBlock.setParent(this);
				textBlock.text = Utils.isNullOrEmpty(this.facts[i].name) ? "Title" : this.facts[i].name;
				textBlock.size = this.hostConfig.factSet.title.size;
				textBlock.color = this.hostConfig.factSet.title.color;
				textBlock.isSubtle = this.hostConfig.factSet.title.isSubtle;
				textBlock.weight = this.hostConfig.factSet.title.weight;
				textBlock.wrap = this.hostConfig.factSet.title.wrap;
				textBlock.spacing = Enums.Spacing.None;

				Utils.appendChild(tdElement, textBlock.render());
				Utils.appendChild(trElement, tdElement);

				// Spacer column
				tdElement = document.createElement("td");
				tdElement.style.width = "10px";

				Utils.appendChild(trElement, tdElement);

				// Value column
				tdElement = document.createElement("td");
				tdElement.style.verticalAlign = "top";
				tdElement.classList.add(hostConfig.makeCssClassName("ac-fact-value"));

				textBlock = new TextBlock();
				textBlock.setParent(this);
				textBlock.text = Utils.isNullOrEmpty(this.facts[i].value) ? "Value" : this.facts[i].value;
				textBlock.size = this.hostConfig.factSet.value.size;
				textBlock.color = this.hostConfig.factSet.value.color;
				textBlock.isSubtle = this.hostConfig.factSet.value.isSubtle;
				textBlock.weight = this.hostConfig.factSet.value.weight;
				textBlock.wrap = this.hostConfig.factSet.value.wrap;
				textBlock.spacing = Enums.Spacing.None;

				Utils.appendChild(tdElement, textBlock.render());
				Utils.appendChild(trElement, tdElement);
				Utils.appendChild(element, trElement);
			}
		}

		return element;
	}

	facts: Array<Fact> = [];

	getJsonTypeName(): string {
		return "FactSet";
	}

	toJSON() {
		let result = super.toJSON();

		let facts = []

		for (let fact of this.facts) {
			facts.push(fact.toJSON());
		}

		Utils.setProperty(result, "facts", facts);

		return result;
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.facts = [];

		if (json["facts"] != null) {
			var jsonFacts = json["facts"] as Array<any>;

			this.facts = [];

			for (var i = 0; i < jsonFacts.length; i++) {
				let fact = new Fact();

				fact.name = jsonFacts[i]["title"];
				fact.value = jsonFacts[i]["value"];
				fact.speak = jsonFacts[i]["speak"];

				this.facts.push(fact);
			}
		}
	}

	renderSpeech(): string {
		if (this.speak != null) {
			return this.speak + '\n';
		}

		// render each fact
		let speak = null;

		if (this.facts.length > 0) {
			speak = '';

			for (var i = 0; i < this.facts.length; i++) {
				let speech = this.facts[i].renderSpeech();

				if (speech) {
					speak += speech;
				}
			}
		}

		return '<p>' + speak + '\n</p>\n';
	}
}

export class Image extends CardElement {
	private _selectAction: Action;

	private parseDimension(name: string, value: any, errors: Array<HostConfig.IValidationError>): number {
		if (value) {
			if (typeof value === "string") {
				try {
					let size = Shared.SizeAndUnit.parse(value);

					if (size.unit == Enums.SizeUnit.Pixel) {
						return size.physicalSize;
					}
				}
				catch {
					// Ignore error
				}
			}

			raiseParseError(
				{
					error: Enums.ValidationError.InvalidPropertyValue,
					message: "Invalid image " + name + ": " + value
				},
				errors
			);
		}

		return 0;
	}

	private applySize(element: HTMLElement) {
		if (this.pixelWidth || this.pixelHeight) {
			if (this.pixelWidth) {
				element.style.width = this.pixelWidth + "px";
			}

			if (this.pixelHeight) {
				element.style.height = this.pixelHeight + "px";
			}
		}
		else {
			switch (this.size) {
				case Enums.Size.Stretch:
					element.style.width = "100%";
					break;
				case Enums.Size.Auto:
					element.style.maxWidth = "100%";
					break;
				case Enums.Size.Small:
					element.style.width = this.hostConfig.imageSizes.small + "px";
					break;
				case Enums.Size.Large:
					element.style.width = this.hostConfig.imageSizes.large + "px";
					break;
				case Enums.Size.Medium:
					element.style.width = this.hostConfig.imageSizes.medium + "px";
					break;
			}
		}
	}

	protected get useDefaultSizing() {
		return false;
	}

	protected internalRender(): HTMLElement {
		var element: HTMLElement = null;

		if (!Utils.isNullOrEmpty(this.url)) {
			element = document.createElement("div");
			element.style.display = "flex";
			element.style.alignItems = "flex-start";

			element.onkeypress = (e) => {
				if (this.selectAction) {
					if (e.keyCode == 13 || e.keyCode == 32) { // enter or space pressed
						this.selectAction.execute();
					}
				}
			}

			element.onclick = (e) => {
				if (this.selectAction) {
					this.selectAction.execute();
					e.cancelBubble = true;
				}
			}

			switch (this.horizontalAlignment) {
				case Enums.HorizontalAlignment.Center:
					element.style.justifyContent = "center";
					break;
				case Enums.HorizontalAlignment.Right:
					element.style.justifyContent = "flex-end";
					break;
				default:
					element.style.justifyContent = "flex-start";
					break;
			}

			// Cache hostConfig to avoid walking the parent hierarchy multiple times
			let hostConfig = this.hostConfig;

			let imageElement = document.createElement("img");
			imageElement.onload = (e: Event) => {
				raiseImageLoadedEvent(this);
			}
			imageElement.onerror = (e: Event) => {
				let card = this.getRootElement() as AdaptiveCard;

				this.renderedElement.innerHTML = "";

				if (card && card.designMode) {
					let errorElement = document.createElement("div");
					errorElement.style.display = "flex";
					errorElement.style.alignItems = "center";
					errorElement.style.justifyContent = "center";
					errorElement.style.backgroundColor = "#EEEEEE";
					errorElement.style.color = "black";
					errorElement.innerText = ":-(";
					errorElement.style.padding = "10px";

					this.applySize(errorElement);

					this.renderedElement.appendChild(errorElement);
				}

				raiseImageLoadedEvent(this);
			}
			imageElement.style.maxHeight = "100%";
			imageElement.style.minWidth = "0";
			imageElement.classList.add(hostConfig.makeCssClassName("ac-image"));

			if (this.selectAction != null && hostConfig.supportsInteractivity) {
				imageElement.tabIndex = 0
				imageElement.setAttribute("role", "button");
				imageElement.setAttribute("aria-label", this.selectAction.title);
				imageElement.classList.add(hostConfig.makeCssClassName("ac-selectable"));
			}

			this.applySize(imageElement);

			if (this.style === Enums.ImageStyle.Person) {
				imageElement.style.borderRadius = "50%";
				imageElement.style.backgroundPosition = "50% 50%";
				imageElement.style.backgroundRepeat = "no-repeat";
			}

			if (!Utils.isNullOrEmpty(this.backgroundColor)) {
				imageElement.style.backgroundColor = Utils.stringToCssColor(this.backgroundColor);
			}

			imageElement.src = this.url;
			imageElement.alt = this.altText;

			element.appendChild(imageElement);
		}

		return element;
	}

	style: Enums.ImageStyle = Enums.ImageStyle.Default;
	backgroundColor: string;
	url: string;
	size: Enums.Size = Enums.Size.Auto;
	width: Shared.SizeAndUnit;
	pixelWidth?: number = null;
	pixelHeight?: number = null;
	altText: string = "";

	toJSON() {
		let result = super.toJSON();

		if (this._selectAction) {
			Utils.setProperty(result, "selectAction", this._selectAction.toJSON());
		}

		Utils.setEnumProperty(Enums.ImageStyle, result, "style", this.style, Enums.ImageStyle.Default);
		Utils.setProperty(result, "backgroundColor", this.backgroundColor);
		Utils.setProperty(result, "url", this.url);
		Utils.setEnumProperty(Enums.Size, result, "size", this.size, Enums.Size.Auto);

		if (this.pixelWidth) {
			Utils.setProperty(result, "width", this.pixelWidth + "px");
		}

		if (this.pixelHeight) {
			Utils.setProperty(result, "height", this.pixelHeight + "px");
		}

		Utils.setProperty(result, "altText", this.altText);

		return result;
	}

	getJsonTypeName(): string {
		return "Image";
	}

	getActionById(id: string) {
		var result = super.getActionById(id);

		if (!result && this.selectAction) {
			result = this.selectAction.getActionById(id);
		}

		return result;
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.url = json["url"];
		this.backgroundColor = json["backgroundColor"];

		var styleString = json["style"];

		if (styleString && typeof styleString === "string" && styleString.toLowerCase() === "normal") {
			this.style = Enums.ImageStyle.Default;

			raiseParseError(
				{
					error: Enums.ValidationError.Deprecated,
					message: "The Image.style value \"normal\" is deprecated and will be removed. Use \"default\" instead."
				},
				errors
			);
		}
		else {
			this.style = Utils.getEnumValueOrDefault(Enums.ImageStyle, styleString, this.style);
		}

		this.size = Utils.getEnumValueOrDefault(Enums.Size, json["size"], this.size);
		this.altText = json["altText"];

		// pixelWidth and pixelHeight are only parsed for backwards compatibility.
		// Payloads should use the width and height proerties instead.
		if (json["pixelWidth"] && typeof json["pixelWidth"] === "number") {
			this.pixelWidth = json["pixelWidth"];

			raiseParseError(
				{
					error: Enums.ValidationError.Deprecated,
					message: "The pixelWidth property is deprecated and will be removed. Use the width property instead."
				},
				errors
			);
		}

		if (json["pixelHeight"] && typeof json["pixelHeight"] === "number") {
			this.pixelHeight = json["pixelHeight"];

			raiseParseError(
				{
					error: Enums.ValidationError.Deprecated,
					message: "The pixelHeight property is deprecated and will be removed. Use the height property instead."
				},
				errors
			);
		}

		let size = this.parseDimension("width", json["width"], errors);

		if (size > 0) {
			this.pixelWidth = size;
		}

		size = this.parseDimension("height", json["height"], errors);

		if (size > 0) {
			this.pixelHeight = size;
		}

		this.selectAction = createActionInstance(
			this,
			json["selectAction"],
			errors);
	}

	getResourceInformation(): Array<Shared.IResourceInformation> {
		if (!Utils.isNullOrEmpty(this.url)) {
			return [{ url: this.url, mimeType: "image" }]
		}
		else {
			return [];
		}
	}

	renderSpeech(): string {
		if (this.speak != null) {
			return this.speak + '\n';
		}

		return null;
	}

	get selectAction(): Action {
		return this._selectAction;
	}

	set selectAction(value: Action) {
		this._selectAction = value;

		if (this._selectAction) {
			this._selectAction.setParent(this);
		}
	}
}

export abstract class CardElementContainer extends CardElement {
	private _selectAction: Action = null;

	protected applyPadding() {
		// Do nothing in base implementation
	}

	protected getSelectAction(): Action {
		return this._selectAction;
	}

	protected setSelectAction(value: Action) {
		this._selectAction = value;

		if (this._selectAction) {
			this._selectAction.setParent(this);
		}
	}

	protected get isSelectable(): boolean {
		return false;
	}

	abstract getItemCount(): number;
	abstract getItemAt(index: number): CardElement;
	abstract getFirstVisibleRenderedItem(): CardElement;
	abstract getLastVisibleRenderedItem(): CardElement;
	abstract removeItem(item: CardElement): boolean;

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		if (this.isSelectable) {
			this._selectAction = createActionInstance(
				this,
				json["selectAction"],
				errors);
		}
	}

	toJSON() {
		let result = super.toJSON();

		if (this._selectAction && this.isSelectable) {
			Utils.setProperty(result, "selectAction", this._selectAction.toJSON());
		}

		return result;
	}

	validate(): Array<HostConfig.IValidationError> {
		var result: Array<HostConfig.IValidationError> = [];

		for (var i = 0; i < this.getItemCount(); i++) {
			result = result.concat(this.getItemAt(i).validate());
		}

		if (this._selectAction) {
			result = result.concat(this._selectAction.validate());
		}

		return result;
	}

	render(): HTMLElement {
		let element = super.render();
		let hostConfig = this.hostConfig;

		if (this.isSelectable && this._selectAction && hostConfig.supportsInteractivity) {
			element.classList.add(hostConfig.makeCssClassName("ac-selectable"));
			element.tabIndex = 0;
			element.setAttribute("role", "button");
			element.setAttribute("aria-label", this._selectAction.title);

			element.onclick = (e) => {
				if (this._selectAction != null) {
					this._selectAction.execute();
					e.cancelBubble = true;
				}
			}

			element.onkeypress = (e) => {
				if (this._selectAction != null) {
					// Enter or space pressed
					if (e.keyCode == 13 || e.keyCode == 32) {
						this._selectAction.execute();
					}
				}
			}
		}

		return element;
	}

	updateLayout(processChildren: boolean = true) {
		super.updateLayout(processChildren);

		this.applyPadding();

		if (processChildren) {
			for (var i = 0; i < this.getItemCount(); i++) {
				this.getItemAt(i).updateLayout();
			}
		}
	}

	getAllInputs(): Array<Input> {
		var result: Array<Input> = [];

		for (var i = 0; i < this.getItemCount(); i++) {
			result = result.concat(this.getItemAt(i).getAllInputs());
		}

		return result;
	}

	getResourceInformation(): Array<Shared.IResourceInformation> {
		let result: Array<Shared.IResourceInformation> = [];

		for (var i = 0; i < this.getItemCount(); i++) {
			result = result.concat(this.getItemAt(i).getResourceInformation());
		}

		return result;
	}

	getElementById(id: string): CardElement {
		let result = super.getElementById(id);

		if (!result) {
			for (var i = 0; i < this.getItemCount(); i++) {
				result = this.getItemAt(i).getElementById(id);

				if (result) {
					break;
				}
			}
		}

		return result;
	}
}

export class ImageSet extends CardElementContainer {
	private _images: Array<Image> = [];

	protected internalRender(): HTMLElement {
		let element: HTMLElement = null;

		if (this._images.length > 0) {
			element = document.createElement("div");
			element.style.display = "flex";
			element.style.flexWrap = "wrap";

			for (var i = 0; i < this._images.length; i++) {
				this._images[i].size = this.imageSize;

				let renderedImage = this._images[i].render();

				renderedImage.style.display = "inline-flex";
				renderedImage.style.margin = "0px";
				renderedImage.style.marginRight = "10px";
				renderedImage.style.maxHeight = this.hostConfig.imageSet.maxImageHeight + "px";

				Utils.appendChild(element, renderedImage);
			}
		}

		return element;
	}

	imageSize: Enums.Size = Enums.Size.Medium;

	getItemCount(): number {
		return this._images.length;
	}

	getItemAt(index: number): CardElement {
		return this._images[index];
	}

	getFirstVisibleRenderedItem(): CardElement {
		return this._images && this._images.length > 0 ? this._images[0] : null;
	}

	getLastVisibleRenderedItem(): CardElement {
		return this._images && this._images.length > 0 ? this._images[this._images.length - 1] : null;
	}

	removeItem(item: CardElement): boolean {
		if (item instanceof Image) {
			var itemIndex = this._images.indexOf(item);

			if (itemIndex >= 0) {
				this._images.splice(itemIndex, 1);

				item.setParent(null);

				this.updateLayout();

				return true;
			}
		}

		return false;
	}

	getJsonTypeName(): string {
		return "ImageSet";
	}

	toJSON() {
		let result = super.toJSON();

		Utils.setEnumProperty(Enums.Size, result, "imageSize", this.imageSize, Enums.Size.Medium);

		if (this._images.length > 0) {
			let images = [];

			for (let image of this._images) {
				images.push(image.toJSON());
			}

			Utils.setProperty(result, "images", images);
		}

		return result;
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.imageSize = Utils.getEnumValueOrDefault(Enums.Size, json["imageSize"], Enums.Size.Medium);

		if (json["images"] != null) {
			let jsonImages = json["images"] as Array<any>;

			this._images = [];

			for (let i = 0; i < jsonImages.length; i++) {
				var image = new Image();
				image.parse(jsonImages[i], errors);

				this.addImage(image);
			}
		}
	}

	addImage(image: Image) {
		if (!image.parent) {
			this._images.push(image);

			image.setParent(this);
		}
		else {
			throw new Error("This image already belongs to another ImageSet");
		}
	}

	indexOf(cardElement: CardElement): number {
		return cardElement instanceof Image ? this._images.indexOf(cardElement) : -1;
	}

	renderSpeech(): string {
		if (this.speak != null) {
			return this.speak;
		}

		var speak = null;

		if (this._images.length > 0) {
			speak = '';

			for (var i = 0; i < this._images.length; i++) {
				speak += this._images[i].renderSpeech();
			}
		}

		return speak;
	}
}

export class MediaSource {
	mimeType: string;
	url: string;

	constructor(url: string = undefined, mimeType: string = undefined) {
		this.url = url;
		this.mimeType = mimeType;
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		this.mimeType = json["mimeType"];
		this.url = json["url"];
	}

	toJSON() {
		return {
			mimeType: this.mimeType,
			url: this.url
		}
	}
}

export class Media extends CardElement {
	static readonly supportedMediaTypes = ["audio", "video"];

	private _selectedMediaType: string;
	private _selectedSources: Array<MediaSource>;

	private getPosterUrl(): string {
		return this.poster ? this.poster : this.hostConfig.media.defaultPoster;
	}

	private processSources() {
		this._selectedSources = [];
		this._selectedMediaType = undefined;

		for (let source of this.sources) {
			let mimeComponents = source.mimeType.split('/');

			if (mimeComponents.length == 2) {
				if (!this._selectedMediaType) {
					let index = Media.supportedMediaTypes.indexOf(mimeComponents[0]);

					if (index >= 0) {
						this._selectedMediaType = Media.supportedMediaTypes[index];
					}
				}
				if (mimeComponents[0] == this._selectedMediaType) {
					this._selectedSources.push(source);
				}
			}
		}
	}

	private renderPoster(): HTMLElement {
		const playButtonArrowWidth = 12;
		const playButtonArrowHeight = 15;

		let posterRootElement = document.createElement("div");
		posterRootElement.className = "ac-media-poster";
		posterRootElement.setAttribute("role", "contentinfo");
		posterRootElement.setAttribute("aria-label", this.altText ? this.altText : "Media content");
		posterRootElement.style.position = "relative";
		posterRootElement.style.display = "flex";

		let posterUrl = this.getPosterUrl();

		if (posterUrl) {
			let posterImageElement = document.createElement("img");
			posterImageElement.style.width = "100%";
			posterImageElement.style.height = "100%";

			posterImageElement.onerror = (e: Event) => {
				posterImageElement.parentNode.removeChild(posterImageElement);
				posterRootElement.classList.add("empty");
				posterRootElement.style.minHeight = "150px";
			}

			posterImageElement.src = posterUrl;

			posterRootElement.appendChild(posterImageElement);
		}
		else {
			posterRootElement.classList.add("empty");
			posterRootElement.style.minHeight = "150px";
		}

		if (this.hostConfig.supportsInteractivity && this._selectedSources.length > 0) {
			let playButtonOuterElement = document.createElement("div");
			playButtonOuterElement.setAttribute("role", "button");
			playButtonOuterElement.setAttribute("aria-label", "Play media");
			playButtonOuterElement.className = "ac-media-playButton";
			playButtonOuterElement.style.display = "flex";
			playButtonOuterElement.style.alignItems = "center";
			playButtonOuterElement.style.justifyContent = "center";
			playButtonOuterElement.onclick = (e) => {
				if (this.hostConfig.media.allowInlinePlayback) {
					let mediaPlayerElement = this.renderMediaPlayer();

					this.renderedElement.innerHTML = "";
					this.renderedElement.appendChild(mediaPlayerElement);

					mediaPlayerElement.play();
				}
				else {
					if (Media.onPlay) {
						Media.onPlay(this);
					}
				}
			}

			let playButtonInnerElement = document.createElement("div");
			playButtonInnerElement.className = "ac-media-playButton-arrow";
			playButtonInnerElement.style.width = playButtonArrowWidth + "px";
			playButtonInnerElement.style.height = playButtonArrowHeight + "px";
			playButtonInnerElement.style.borderTopWidth = (playButtonArrowHeight / 2) + "px";
			playButtonInnerElement.style.borderBottomWidth = (playButtonArrowHeight / 2) + "px";
			playButtonInnerElement.style.borderLeftWidth = playButtonArrowWidth + "px";
			playButtonInnerElement.style.borderRightWidth = "0";
			playButtonInnerElement.style.borderStyle = "solid";
			playButtonInnerElement.style.borderTopColor = "transparent";
			playButtonInnerElement.style.borderRightColor = "transparent";
			playButtonInnerElement.style.borderBottomColor = "transparent";
			playButtonInnerElement.style.transform = "translate(" + (playButtonArrowWidth / 10) + "px,0px)";

			playButtonOuterElement.appendChild(playButtonInnerElement);

			let playButtonContainer = document.createElement("div");
			playButtonContainer.style.position = "absolute";
			playButtonContainer.style.left = "0";
			playButtonContainer.style.top = "0";
			playButtonContainer.style.width = "100%";
			playButtonContainer.style.height = "100%";
			playButtonContainer.style.display = "flex";
			playButtonContainer.style.justifyContent = "center";
			playButtonContainer.style.alignItems = "center";

			playButtonContainer.appendChild(playButtonOuterElement);
			posterRootElement.appendChild(playButtonContainer);
		}

		return posterRootElement;
	}

	private renderMediaPlayer(): HTMLMediaElement {
		let mediaElement: HTMLMediaElement;

		if (this._selectedMediaType == "video") {
			let videoPlayer = document.createElement("video");

			let posterUrl = this.getPosterUrl();

			if (posterUrl) {
				videoPlayer.poster = posterUrl;
			}

			mediaElement = videoPlayer;
		}
		else {
			mediaElement = document.createElement("audio");
		}

		mediaElement.controls = true;
		mediaElement.preload = "none";
		mediaElement.style.width = "100%";

		for (let source of this.sources) {
			let src: HTMLSourceElement = document.createElement("source");
			src.src = source.url;
			src.type = source.mimeType;

			mediaElement.appendChild(src);
		}

		return mediaElement;
	}

	protected internalRender(): HTMLElement {
		let element = <HTMLElement>document.createElement("div");
		element.className = this.hostConfig.makeCssClassName("ac-media");

		this.processSources();

		element.appendChild(this.renderPoster());

		return element;
	}

	static onPlay: (sender: Media) => void;

	sources: Array<MediaSource> = [];
	poster: string;
	altText: string;

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.poster = json["poster"];
		this.altText = json["altText"];

		if (json["sources"] != null) {
			let jsonSources = json["sources"] as Array<any>;

			this.sources = [];

			for (let i = 0; i < jsonSources.length; i++) {
				let source = new MediaSource();
				source.parse(jsonSources[i], errors);

				this.sources.push(source);
			}
		}
	}

	toJSON() {
		let result = super.toJSON();

		Utils.setProperty(result, "poster", this.poster);
		Utils.setProperty(result, "altText", this.altText);

		if (this.sources.length > 0) {
			let serializedSources = [];

			for (let source of this.sources) {
				serializedSources.push(source.toJSON());
			}

			Utils.setProperty(result, "sources", serializedSources);
		}

		return result;
	}

	getJsonTypeName(): string {
		return "Media";
	}

	getResourceInformation(): Array<Shared.IResourceInformation> {
		let result: Array<Shared.IResourceInformation> = [];

		let posterUrl = this.getPosterUrl();

		if (!Utils.isNullOrEmpty(posterUrl)) {
			result.push({ url: posterUrl, mimeType: "image" });
		}

		for (let mediaSource of this.sources) {
			if (!Utils.isNullOrEmpty(mediaSource.url)) {
				result.push({ url: mediaSource.url, mimeType: mediaSource.mimeType });
			}
		}

		return result;
	}

	renderSpeech(): string {
		return this.altText;
	}

	get selectedMediaType(): string {
		return this._selectedMediaType;
	}
}

export abstract class Input extends CardElement implements Shared.IInput {
	protected valueChanged() {
		if (this.onValueChanged) {
			this.onValueChanged(this);
		}
	}

	abstract get value(): string;

	onValueChanged: (sender: Input) => void;

	title: string;
	defaultValue: string;

	toJSON() {
		let result = super.toJSON();

		Utils.setProperty(result, "title", this.title);
		Utils.setProperty(result, "value", this.renderedElement ? this.value : this.defaultValue);

		return result;
	}

	validate(): Array<HostConfig.IValidationError> {
		if (!this.id) {
			return [{ error: Enums.ValidationError.PropertyCantBeNull, message: "All inputs must have a unique Id" }];
		}
		else {
			return [];
		}
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.id = json["id"];
		this.defaultValue = json["value"];
	}

	renderSpeech(): string {
		if (this.speak != null) {
			return this.speak;
		}

		if (this.title) {
			return '<s>' + this.title + '</s>\n';
		}

		return null;
	}

	getAllInputs(): Array<Input> {
		return [this];
	}

	get isInteractive(): boolean {
		return true;
	}
}

export class TextInput extends Input {
	private _textareaElement: HTMLTextAreaElement;
	private _inputElement: HTMLInputElement;

	protected internalRender(): HTMLElement {
		if (this.isMultiline) {
			this._textareaElement = document.createElement("textarea");
			this._textareaElement.className = this.hostConfig.makeCssClassName("ac-input", "ac-textInput", "ac-multiline");
			this._textareaElement.style.width = "100%";
			this._textareaElement.tabIndex = 0;

			if (!Utils.isNullOrEmpty(this.placeholder)) {
				this._textareaElement.placeholder = this.placeholder;
				this._textareaElement.setAttribute("aria-label", this.placeholder)
			}

			if (!Utils.isNullOrEmpty(this.defaultValue)) {
				this._textareaElement.value = this.defaultValue;
			}

			if (this.maxLength > 0) {
				this._textareaElement.maxLength = this.maxLength;
			}

			this._textareaElement.oninput = () => { this.valueChanged(); }

			return this._textareaElement;
		}
		else {
			this._inputElement = document.createElement("input");
			this._inputElement.type = Enums.InputTextStyle[this.style].toLowerCase();
			this._inputElement.className = this.hostConfig.makeCssClassName("ac-input", "ac-textInput");
			this._inputElement.style.width = "100%";
			this._inputElement.tabIndex = 0;

			if (!Utils.isNullOrEmpty(this.placeholder)) {
				this._inputElement.placeholder = this.placeholder;
				this._inputElement.setAttribute("aria-label", this.placeholder)
			}

			if (!Utils.isNullOrEmpty(this.defaultValue)) {
				this._inputElement.value = this.defaultValue;
			}

			if (this.maxLength > 0) {
				this._inputElement.maxLength = this.maxLength;
			}

			this._inputElement.oninput = () => { this.valueChanged(); }

			return this._inputElement;
		}
	}

	maxLength: number;
	isMultiline: boolean = false;
	placeholder: string;
	style: Enums.InputTextStyle = Enums.InputTextStyle.Text;

	getJsonTypeName(): string {
		return "Input.Text";
	}

	toJSON() {
		let result = super.toJSON();

		Utils.setProperty(result, "placeholder", this.placeholder);
		Utils.setProperty(result, "maxLength", this.maxLength, 0);
		Utils.setProperty(result, "isMultiline", this.isMultiline, false);
		Utils.setEnumProperty(Enums.InputTextStyle, result, "style", this.style, Enums.InputTextStyle.Text);

		return result;
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.maxLength = json["maxLength"];
		this.isMultiline = Utils.parseBoolProperty(json["isMultiline"], this.isMultiline);
		this.placeholder = json["placeholder"];
		this.style = Utils.getEnumValueOrDefault(Enums.InputTextStyle, json["style"], this.style);
	}

	get value(): string {
		if (this.isMultiline) {
			return this._textareaElement ? this._textareaElement.value : null;
		}
		else {
			return this._inputElement ? this._inputElement.value : null;
		}
	}
}

export class ToggleInput extends Input {
	private _checkboxInputElement: HTMLInputElement;

	protected internalRender(): HTMLElement {
		let element = document.createElement("div");
		element.className = this.hostConfig.makeCssClassName("ac-input");
		element.style.width = "100%";
		element.style.display = "flex";
		element.style.alignItems = "center";

		this._checkboxInputElement = document.createElement("input");
		this._checkboxInputElement.id = Utils.generateUniqueId();
		this._checkboxInputElement.type = "checkbox";
		this._checkboxInputElement.style.display = "inline-block";
		this._checkboxInputElement.style.verticalAlign = "middle";
		this._checkboxInputElement.style.margin = "0";
		this._checkboxInputElement.style.flex = "0 0 auto";
		this._checkboxInputElement.setAttribute("aria-label", this.title);
		this._checkboxInputElement.tabIndex = 0;

		if (this.defaultValue == this.valueOn) {
			this._checkboxInputElement.checked = true;
		}

		this._checkboxInputElement.onchange = () => { this.valueChanged(); }

		Utils.appendChild(element, this._checkboxInputElement);

		if (!Utils.isNullOrEmpty(this.title) || this.isDesignMode()) {
			let label = new Label();
			label.setParent(this);
			label.forElementId = this._checkboxInputElement.id;
			label.hostConfig = this.hostConfig;
			label.text = Utils.isNullOrEmpty(this.title) ? this.getJsonTypeName() : this.title;
			label.useMarkdown = AdaptiveCard.useMarkdownInRadioButtonAndCheckbox;
			label.wrap = this.wrap;

			let labelElement = label.render();
			labelElement.style.display = "inline-block";
			labelElement.style.flex = "1 1 auto";
			labelElement.style.marginLeft = "6px";
			labelElement.style.verticalAlign = "middle";

			let spacerElement = document.createElement("div");
			spacerElement.style.width = "6px";

			Utils.appendChild(element, spacerElement);
			Utils.appendChild(element, labelElement);
		}

		return element;
	}

	valueOn: string = "true";
	valueOff: string = "false";
	wrap: boolean = false;

	getJsonTypeName(): string {
		return "Input.Toggle";
	}

	toJSON() {
		let result = super.toJSON();

		Utils.setProperty(result, "valueOn", this.valueOn, "true");
		Utils.setProperty(result, "valueOff", this.valueOff, "false");
		Utils.setProperty(result, "wrap", this.wrap);

		return result;
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.title = json["title"];

		this.valueOn = Utils.getValueOrDefault<string>(json["valueOn"], this.valueOn);
		this.valueOff = Utils.getValueOrDefault<string>(json["valueOff"], this.valueOff);
		this.wrap = Utils.parseBoolProperty(json["wrap"], this.wrap);
	}

	get value(): string {
		if (this._checkboxInputElement) {
			return this._checkboxInputElement.checked ? this.valueOn : this.valueOff;
		}
		else {
			return null;
		}
	}
}

export class Choice {
	title: string;
	value: string;

	constructor(title: string = undefined, value: string = undefined) {
		this.title = title;
		this.value = value;
	}

	toJSON() {
		return { title: this.title, value: this.value };
	}
}

export class ChoiceSetInput extends Input {
	private static uniqueCategoryCounter = 0;

	private static getUniqueCategoryName(): string {
		let uniqueCwtegoryName = "__ac-category" + ChoiceSetInput.uniqueCategoryCounter;

		ChoiceSetInput.uniqueCategoryCounter++;

		return uniqueCwtegoryName;
	}

	private _selectElement: HTMLSelectElement;
	private _toggleInputs: Array<HTMLInputElement>;

	protected internalRender(): HTMLElement {
		if (!this.isMultiSelect) {
			if (this.isCompact) {
				// Render as a combo box
				this._selectElement = document.createElement("select");
				this._selectElement.className = this.hostConfig.makeCssClassName("ac-input", "ac-multichoiceInput");
				this._selectElement.style.width = "100%";

				let option = document.createElement("option");
				option.selected = true;
				option.disabled = true;
				option.hidden = true;
				option.value = "";

				if (this.placeholder) {
					option.text = this.placeholder;
				}

				Utils.appendChild(this._selectElement, option);

				for (var i = 0; i < this.choices.length; i++) {
					let option = document.createElement("option");
					option.value = this.choices[i].value;
					option.text = this.choices[i].title;
					option.setAttribute("aria-label", this.choices[i].title);

					if (this.choices[i].value == this.defaultValue) {
						option.selected = true;
					}

					Utils.appendChild(this._selectElement, option);
				}

				this._selectElement.onchange = () => { this.valueChanged(); }

				return this._selectElement;
			}
			else {
				// Render as a series of radio buttons
				let uniqueCategoryName = ChoiceSetInput.getUniqueCategoryName();

				let element = document.createElement("div");
				element.className = this.hostConfig.makeCssClassName("ac-input");
				element.style.width = "100%";

				this._toggleInputs = [];

				for (let i = 0; i < this.choices.length; i++) {
					let radioInput = document.createElement("input");
					radioInput.id = Utils.generateUniqueId();
					radioInput.type = "radio";
					radioInput.style.margin = "0";
					radioInput.style.display = "inline-block";
					radioInput.style.verticalAlign = "middle";
					radioInput.name = Utils.isNullOrEmpty(this.id) ? uniqueCategoryName : this.id;
					radioInput.value = this.choices[i].value;
					radioInput.style.flex = "0 0 auto";
					radioInput.setAttribute("aria-label", this.choices[i].title);

					if (this.choices[i].value == this.defaultValue) {
						radioInput.checked = true;
					}

					radioInput.onchange = () => { this.valueChanged(); }

					this._toggleInputs.push(radioInput);

					let label = new Label();
					label.setParent(this);
					label.forElementId = radioInput.id;
					label.hostConfig = this.hostConfig;
					label.text = Utils.isNullOrEmpty(this.choices[i].title) ? "Choice " + i : this.choices[i].title;
					label.useMarkdown = AdaptiveCard.useMarkdownInRadioButtonAndCheckbox;
					label.wrap = this.wrap;

					let labelElement = label.render();
					labelElement.style.display = "inline-block";
					labelElement.style.flex = "1 1 auto";
					labelElement.style.marginLeft = "6px";
					labelElement.style.verticalAlign = "middle";

					let spacerElement = document.createElement("div");
					spacerElement.style.width = "6px";

					let compoundInput = document.createElement("div");
					compoundInput.style.display = "flex";

					Utils.appendChild(compoundInput, radioInput);
					Utils.appendChild(compoundInput, spacerElement);
					Utils.appendChild(compoundInput, labelElement);

					Utils.appendChild(element, compoundInput);
				}

				return element;
			}
		}
		else {
			// Render as a list of toggle inputs
			let defaultValues = this.defaultValue ? this.defaultValue.split(this.hostConfig.choiceSetInputValueSeparator) : null;

			let element = document.createElement("div");
			element.className = this.hostConfig.makeCssClassName("ac-input");
			element.style.width = "100%";

			this._toggleInputs = [];

			for (let i = 0; i < this.choices.length; i++) {
				let checkboxInput = document.createElement("input");
				checkboxInput.id = Utils.generateUniqueId();
				checkboxInput.type = "checkbox";
				checkboxInput.style.margin = "0";
				checkboxInput.style.display = "inline-block";
				checkboxInput.style.verticalAlign = "middle";
				checkboxInput.value = this.choices[i].value;
				checkboxInput.style.flex = "0 0 auto";
				checkboxInput.setAttribute("aria-label", this.choices[i].title);

				if (defaultValues) {
					if (defaultValues.indexOf(this.choices[i].value) >= 0) {
						checkboxInput.checked = true;
					}
				}

				checkboxInput.onchange = () => { this.valueChanged(); }

				this._toggleInputs.push(checkboxInput);

				let label = new Label();
				label.setParent(this);
				label.forElementId = checkboxInput.id;
				label.hostConfig = this.hostConfig;
				label.text = Utils.isNullOrEmpty(this.choices[i].title) ? "Choice " + i : this.choices[i].title;
				label.useMarkdown = AdaptiveCard.useMarkdownInRadioButtonAndCheckbox;
				label.wrap = this.wrap;

				let labelElement = label.render();
				labelElement.style.display = "inline-block";
				labelElement.style.flex = "1 1 auto";
				labelElement.style.marginLeft = "6px";
				labelElement.style.verticalAlign = "middle";

				let spacerElement = document.createElement("div");
				spacerElement.style.width = "6px";

				let compoundInput = document.createElement("div");
				compoundInput.style.display = "flex";
				compoundInput.style.alignItems = "center";

				Utils.appendChild(compoundInput, checkboxInput);
				Utils.appendChild(compoundInput, spacerElement);
				Utils.appendChild(compoundInput, labelElement);

				Utils.appendChild(element, compoundInput);
			}

			return element;
		}
	}

	choices: Array<Choice> = [];
	isCompact: boolean = false;
	isMultiSelect: boolean = false;
	placeholder: string;
	wrap: boolean = false;

	getJsonTypeName(): string {
		return "Input.ChoiceSet";
	}

	toJSON() {
		let result = super.toJSON();

		Utils.setProperty(result, "placeholder", this.placeholder);

		if (this.choices.length > 0) {
			var choices = [];

			for (let choice of this.choices) {
				choices.push(choice.toJSON());
			}

			Utils.setProperty(result, "choices", choices);
		}

		if (!this.isCompact) {
			Utils.setProperty(result, "style", "expanded", false);
		}

		Utils.setProperty(result, "isMultiSelect", this.isMultiSelect, false);
		Utils.setProperty(result, "wrap", this.wrap, false);

		return result;
	}

	validate(): Array<HostConfig.IValidationError> {
		var result: Array<HostConfig.IValidationError> = [];

		if (this.choices.length == 0) {
			result = [{ error: Enums.ValidationError.CollectionCantBeEmpty, message: "An Input.ChoiceSet must have at least one choice defined." }];
		}

		for (var i = 0; i < this.choices.length; i++) {
			if (!this.choices[i].title || !this.choices[i].value) {
				result = result.concat([{ error: Enums.ValidationError.PropertyCantBeNull, message: "All choices in an Input.ChoiceSet must have their title and value properties set." }])
				break;
			}
		}

		return result;
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.isCompact = !(json["style"] === "expanded");
		this.isMultiSelect = Utils.parseBoolProperty(json["isMultiSelect"], this.isMultiSelect);
		this.placeholder = json["placeholder"];

		this.choices = [];

		if (json["choices"] != undefined) {
			var choiceArray = json["choices"] as Array<any>;

			for (var i = 0; i < choiceArray.length; i++) {
				var choice = new Choice();

				choice.title = choiceArray[i]["title"];
				choice.value = choiceArray[i]["value"];

				this.choices.push(choice);
			}
		}

		this.wrap = Utils.parseBoolProperty(json["wrap"], this.wrap);
	}

	get value(): string {
		if (!this.isMultiSelect) {
			if (this.isCompact) {
				return this._selectElement ? this._selectElement.value : null;
			}
			else {
				if (!this._toggleInputs || this._toggleInputs.length == 0) {
					return null;
				}

				for (var i = 0; i < this._toggleInputs.length; i++) {
					if (this._toggleInputs[i].checked) {
						return this._toggleInputs[i].value;
					}
				}

				return null;
			}
		}
		else {
			if (!this._toggleInputs || this._toggleInputs.length == 0) {
				return null;
			}

			var result: string = "";

			for (var i = 0; i < this._toggleInputs.length; i++) {
				if (this._toggleInputs[i].checked) {
					if (result != "") {
						result += this.hostConfig.choiceSetInputValueSeparator;
					}

					result += this._toggleInputs[i].value;
				}
			}

			return result == "" ? null : result;
		}
	}
}

export class NumberInput extends Input {
	private _numberInputElement: HTMLInputElement;

	protected internalRender(): HTMLElement {
		this._numberInputElement = document.createElement("input");
		this._numberInputElement.setAttribute("type", "number");
		this._numberInputElement.className = this.hostConfig.makeCssClassName("ac-input", "ac-numberInput");
		this._numberInputElement.setAttribute("min", this.min);
		this._numberInputElement.setAttribute("max", this.max);
		this._numberInputElement.style.width = "100%";
		this._numberInputElement.tabIndex = 0;

		if (!Utils.isNullOrEmpty(this.defaultValue)) {
			this._numberInputElement.value = this.defaultValue;
		}

		if (!Utils.isNullOrEmpty(this.placeholder)) {
			this._numberInputElement.placeholder = this.placeholder;
			this._numberInputElement.setAttribute("aria-label", this.placeholder);
		}

		this._numberInputElement.oninput = () => { this.valueChanged(); }

		return this._numberInputElement;
	}

	min: string;
	max: string;
	placeholder: string;

	getJsonTypeName(): string {
		return "Input.Number";
	}

	toJSON() {
		let result = super.toJSON();

		Utils.setProperty(result, "placeholder", this.placeholder);
		Utils.setProperty(result, "min", this.min);
		Utils.setProperty(result, "max", this.max);

		return result;
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.placeholder = json["placeholder"];
		this.min = json["min"];
		this.max = json["max"];
	}

	get value(): string {
		return this._numberInputElement ? this._numberInputElement.value : null;
	}
}

export class DateInput extends Input {
	private _dateInputElement: HTMLInputElement;

	protected internalRender(): HTMLElement {
		this._dateInputElement = document.createElement("input");
		this._dateInputElement.setAttribute("type", "date");
		this._dateInputElement.className = this.hostConfig.makeCssClassName("ac-input", "ac-dateInput");
		this._dateInputElement.style.width = "100%";

		if (!Utils.isNullOrEmpty(this.defaultValue)) {
			this._dateInputElement.value = this.defaultValue;
		}

		return this._dateInputElement;
	}

	getJsonTypeName(): string {
		return "Input.Date";
	}

	get value(): string {
		return this._dateInputElement ? this._dateInputElement.value : null;
	}
}

export class TimeInput extends Input {
	private _timeInputElement: HTMLInputElement;

	protected internalRender(): HTMLElement {
		this._timeInputElement = document.createElement("input");
		this._timeInputElement.setAttribute("type", "time");
		this._timeInputElement.className = this.hostConfig.makeCssClassName("ac-input", "ac-timeInput");
		this._timeInputElement.style.width = "100%";

		if (!Utils.isNullOrEmpty(this.defaultValue)) {
			this._timeInputElement.value = this.defaultValue;
		}

		return this._timeInputElement;
	}

	getJsonTypeName(): string {
		return "Input.Time";
	}

	get value(): string {
		return this._timeInputElement ? this._timeInputElement.value : null;
	}
}

enum ActionButtonState {
	Normal,
	Expanded,
	Subdued
}

class ActionButton {
	private _parentContainerStyle: string;
	private _state: ActionButtonState = ActionButtonState.Normal;

	private updateCssStyle() {
		let hostConfig = this.action.parent.hostConfig;

		this.action.renderedElement.className = hostConfig.makeCssClassName("ac-pushButton");

		if (!Utils.isNullOrEmpty(this._parentContainerStyle)) {
			this.action.renderedElement.classList.add("style-" + this._parentContainerStyle);
		}

		if (this.action instanceof ShowCardAction) {
			this.action.renderedElement.classList.add(hostConfig.makeCssClassName("expandable"));
		}

		this.action.renderedElement.classList.remove(hostConfig.makeCssClassName("expanded"));
		this.action.renderedElement.classList.remove(hostConfig.makeCssClassName("subdued"));

		switch (this._state) {
			case ActionButtonState.Expanded:
				this.action.renderedElement.classList.add(hostConfig.makeCssClassName("expanded"));
				break;
			case ActionButtonState.Subdued:
				this.action.renderedElement.classList.add(hostConfig.makeCssClassName("subdued"));
				break;
		}

		if (this.action.isPrimary) {
			this.action.renderedElement.classList.add(hostConfig.makeCssClassName("primary"));
		}

	}

	readonly action: Action;

	constructor(action: Action, parentContainerStyle: string) {
		this.action = action;
		this._parentContainerStyle = parentContainerStyle;
	}

	onClick: (actionButton: ActionButton) => void = null;

	render(alignment: Enums.ActionAlignment) {
		this.action.render();
		this.action.renderedElement.style.flex = alignment === Enums.ActionAlignment.Stretch ? "0 1 100%" : "0 1 auto";
		this.action.renderedElement.onclick = (e) => { this.click(); };

		this.updateCssStyle();
	}

	click() {
		if (this.onClick != null) {
			this.onClick(this);
		}
	}

	get state(): ActionButtonState {
		return this._state;
	}

	set state(value: ActionButtonState) {
		this._state = value;

		this.updateCssStyle();
	}
}

export abstract class Action implements ICardObject {
	private _shouldFallback: boolean = false;
	private _parent: CardElement = null;
	private _actionCollection: ActionCollection = null; // hold the reference to its action collection
	private _renderedElement: HTMLElement = null;

	private setCollection(actionCollection: ActionCollection) {
		this._actionCollection = actionCollection;
	}

	protected addCssClasses(element: HTMLElement) {
		// Do nothing in base implementation
	}

	abstract getJsonTypeName(): string;

	readonly requires = new HostConfig.HostCapabilities();

	id: string;
	title: string;
	iconUrl: string;
	isPrimary: boolean;

	onExecute: (sender: Action) => void;

	toJSON() {
		let result = {};

		Utils.setProperty(result, "type", this.getJsonTypeName());
		Utils.setProperty(result, "id", this.id);
		Utils.setProperty(result, "title", this.title);
		Utils.setProperty(result, "iconUrl", this.iconUrl);

		return result;
	}

	render() {
		// Cache hostConfig for perf
		let hostConfig = this.parent.hostConfig;

		var buttonElement = document.createElement("button");
		buttonElement.className = hostConfig.makeCssClassName("ac-pushButton");

		this.addCssClasses(buttonElement);

		buttonElement.setAttribute("aria-label", this.title);
		buttonElement.type = "button";
		buttonElement.style.display = "flex";
		buttonElement.style.alignItems = "center";
		buttonElement.style.justifyContent = "center";

		let hasTitle = !Utils.isNullOrEmpty(this.title);

		let titleElement = document.createElement("div");
		titleElement.style.overflow = "hidden";
		titleElement.style.textOverflow = "ellipsis";

		if (!(hostConfig.actions.iconPlacement == Enums.ActionIconPlacement.AboveTitle || hostConfig.actions.allowTitleToWrap)) {
			titleElement.style.whiteSpace = "nowrap";
		}

		if (hasTitle) {
			titleElement.innerText = this.title;
		}

		if (Utils.isNullOrEmpty(this.iconUrl)) {
			buttonElement.classList.add("noIcon");

			buttonElement.appendChild(titleElement);
		}
		else {
			let iconElement = document.createElement("img");
			iconElement.src = this.iconUrl;
			iconElement.style.width = hostConfig.actions.iconSize + "px";
			iconElement.style.height = hostConfig.actions.iconSize + "px";
			iconElement.style.flex = "0 0 auto";

			if (hostConfig.actions.iconPlacement == Enums.ActionIconPlacement.AboveTitle) {
				buttonElement.classList.add("iconAbove");
				buttonElement.style.flexDirection = "column";

				if (hasTitle) {
					iconElement.style.marginBottom = "4px";
				}
			}
			else {
				buttonElement.classList.add("iconLeft");

				if (hasTitle) {
					iconElement.style.marginRight = "4px";
				}
			}

			buttonElement.appendChild(iconElement);
			buttonElement.appendChild(titleElement);
		}

		this._renderedElement = buttonElement;
	}

	setParent(value: CardElement) {
		this._parent = value;
	}

	execute() {
		if (this.onExecute) {
			this.onExecute(this);
		}

		raiseExecuteActionEvent(this);
	}

	// Expand the action card pane with a inline status card
	// Null status will clear the status bar
	setStatus(status: any) {
		if (this._actionCollection == null) {
			return;
		}

		if (status) {
			let statusCard = new InlineAdaptiveCard();
			statusCard.parse(status);
			this._actionCollection.showStatusCard(statusCard);
		}
		else {
			this._actionCollection.hideStatusCard();
		}
	}

	validate(): Array<HostConfig.IValidationError> {
		return [];
	}

	prepare(inputs: Array<Input>) {
		// Do nothing in base implementation
	};

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		raiseParseActionEvent(this, json, errors);

		this.requires.parse(json["requires"], errors);
		this.id = json["id"];

		if (!json["title"] && json["title"] !== "") {
			raiseParseError(
				{
					error: Enums.ValidationError.PropertyCantBeNull,
					message: "Actions should always have a title."
				},
				errors
			);
		}

		this.title = json["title"];
		this.iconUrl = json["iconUrl"];
	}

	remove(): boolean {
		if (this._actionCollection) {
			return this._actionCollection.removeAction(this);
		}

		return false;
	}

	getAllInputs(): Array<Input> {
		return [];
	}

	getResourceInformation(): Array<Shared.IResourceInformation> {
		if (!Utils.isNullOrEmpty(this.iconUrl)) {
			return [{ url: this.iconUrl, mimeType: "image" }]
		}
		else {
			return [];
		}
	}

	getActionById(id: string): Action {
		if (this.id == id) {
			return this;
		}
	}

	get parent(): CardElement {
		return this._parent;
	}

	get renderedElement(): HTMLElement {
		return this._renderedElement;
	}

	shouldFallback(): boolean {
		return this._shouldFallback || !this.requires.areAllMet(this.parent.hostConfig.hostCapabilities);
	}
}

export class SubmitAction extends Action {
	private _isPrepared: boolean = false;
	private _originalData: Object;
	private _processedData: Object;

	getJsonTypeName(): string {
		return "Action.Submit";
	}

	toJSON() {
		let result = super.toJSON();

		Utils.setProperty(result, "data", this._originalData);

		return result;
	}

	prepare(inputs: Array<Input>) {
		if (this._originalData) {
			this._processedData = JSON.parse(JSON.stringify(this._originalData));
		}
		else {
			this._processedData = {};
		}

		for (var i = 0; i < inputs.length; i++) {
			var inputValue = inputs[i].value;

			if (inputValue != null) {
				this._processedData[inputs[i].id] = inputs[i].value;
			}
		}

		this._isPrepared = true;
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.data = json["data"];
	}

	get data(): Object {
		return this._isPrepared ? this._processedData : this._originalData;
	}

	set data(value: Object) {
		this._originalData = value;
		this._isPrepared = false;
	}
}

export class OpenUrlAction extends Action {
	url: string;

	getJsonTypeName(): string {
		return "Action.OpenUrl";
	}

	toJSON() {
		let result = super.toJSON();

		Utils.setProperty(result, "url", this.url);

		return result;
	}

	validate(): Array<HostConfig.IValidationError> {
		if (!this.url) {
			return [{ error: Enums.ValidationError.PropertyCantBeNull, message: "An Action.OpenUrl must have its url property set." }];
		}
		else {
			return [];
		}
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.url = json["url"];
	}
}

export class ToggleVisibilityAction extends Action {
    targetElements = {}

    getJsonTypeName(): string {
        return "Action.ToggleVisibility";
    }

    execute() {
		for (let elementId of Object.keys(this.targetElements)) {
			let targetElement = this.parent.getRootElement().getElementById(elementId);

			if (targetElement) {
				if (typeof this.targetElements[elementId] === "boolean") {
					targetElement.isVisible = this.targetElements[elementId];
				} 
				else {
					targetElement.isVisible = !targetElement.isVisible;
				}
			}
		}
    }

    parse(json: any) {
		super.parse(json);
		
		this.targetElements = {};

		let jsonTargetElements = json["targetElements"];

		if (jsonTargetElements && Array.isArray(jsonTargetElements)) {
			for (let item of jsonTargetElements) {
				if (typeof item === "string") {
					this.targetElements[item] = undefined;
				}
				else if (typeof item === "object") {
					let jsonElementId = item["elementId"];

					if (jsonElementId && typeof jsonElementId === "string") {
						this.targetElements[jsonElementId] = Utils.parseBoolProperty(item["isVisible"], undefined);
					}
				}
			}
		}
	}
	
	addTargetElement(elementId: string, isVisible: boolean = undefined) {
		this.targetElements[elementId] = isVisible;
	}

	removeTargetElement(elementId) {
		delete this.targetElements[elementId];
	}
}

export class HttpHeader {
	private _value = new Shared.StringWithSubstitutions();

	name: string;

	constructor(name: string = "", value: string = "") {
		this.name = name;
		this.value = value;
	}

	toJSON() {
		return { name: this.name, value: this._value.getOriginal() };
	}

	prepare(inputs: Array<Input>) {
		this._value.substituteInputValues(inputs, Shared.ContentTypes.applicationXWwwFormUrlencoded);
	}

	get value(): string {
		return this._value.get();
	}

	set value(newValue: string) {
		this._value.set(newValue);
	}
}

export class HttpAction extends Action {
	private _url = new Shared.StringWithSubstitutions();
	private _body = new Shared.StringWithSubstitutions();
	private _headers: Array<HttpHeader> = [];

	method: string;

	getJsonTypeName(): string {
		return "Action.Http";
	}

	toJSON() {
		let result = super.toJSON();

		Utils.setProperty(result, "method", this.method);
		Utils.setProperty(result, "url", this._url.getOriginal());
		Utils.setProperty(result, "body", this._body.getOriginal());

		if (this._headers.length > 0) {
			let headers = [];

			for (let header of this._headers) {
				headers.push(header.toJSON());
			}

			Utils.setProperty(result, "headers", headers);
		}

		return result;
	}

	validate(): Array<HostConfig.IValidationError> {
		var result: Array<HostConfig.IValidationError> = [];

		if (!this.url) {
			result = [{ error: Enums.ValidationError.PropertyCantBeNull, message: "An Action.Http must have its url property set." }];
		}

		if (this.headers.length > 0) {
			for (var i = 0; i < this.headers.length; i++) {
				if (!this.headers[i].name || !this.headers[i].value) {
					result = result.concat([{ error: Enums.ValidationError.PropertyCantBeNull, message: "All headers of an Action.Http must have their name and value properties set." }]);
					break;
				}
			}
		}

		return result;
	}

	prepare(inputs: Array<Input>) {
		this._url.substituteInputValues(inputs, Shared.ContentTypes.applicationXWwwFormUrlencoded);

		let contentType = Shared.ContentTypes.applicationJson;

		for (var i = 0; i < this._headers.length; i++) {
			this._headers[i].prepare(inputs);

			if (this._headers[i].name && this._headers[i].name.toLowerCase() == "content-type") {
				contentType = this._headers[i].value;
			}
		}

		this._body.substituteInputValues(inputs, contentType);
	};

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.url = json["url"];
		this.method = json["method"];
		this.body = json["body"];

		this._headers = [];

		if (json["headers"] != null) {
			var jsonHeaders = json["headers"] as Array<any>;

			for (var i = 0; i < jsonHeaders.length; i++) {
				let httpHeader = new HttpHeader();

				httpHeader.name = jsonHeaders[i]["name"];
				httpHeader.value = jsonHeaders[i]["value"];

				this.headers.push(httpHeader);
			}
		}
	}

	get url(): string {
		return this._url.get();
	}

	set url(value: string) {
		this._url.set(value);
	}

	get body(): string {
		return this._body.get();
	}

	set body(value: string) {
		this._body.set(value);
	}

	get headers(): Array<HttpHeader> {
		return this._headers ? this._headers : [];
	}

	set headers(value: Array<HttpHeader>) {
		this._headers = value;
	}
}

export class ShowCardAction extends Action {
	protected addCssClasses(element: HTMLElement) {
		super.addCssClasses(element);

		element.classList.add(this.parent.hostConfig.makeCssClassName("expandable"));
	}

	readonly card: AdaptiveCard = new InlineAdaptiveCard();

	getJsonTypeName(): string {
		return "Action.ShowCard";
	}

	toJSON() {
		let result = super.toJSON();

		if (this.card) {
			Utils.setProperty(result, "card", this.card.toJSON());
		}

		return result;
	}

	validate(): Array<HostConfig.IValidationError> {
		return this.card.validate();
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.card.parse(json["card"], errors);
	}

	setParent(value: CardElement) {
		super.setParent(value);

		this.card.setParent(value);
	}

	getAllInputs(): Array<Input> {
		return this.card.getAllInputs();
	}

	getResourceInformation(): Array<Shared.IResourceInformation> {
		return super.getResourceInformation().concat(this.card.getResourceInformation());
	}

	getActionById(id: string): Action {
		var result = super.getActionById(id);

		if (!result) {
			result = this.card.getActionById(id);
		}

		return result;
	}
}

class ActionCollection {
	private _owner: CardElement;
	private _actionCardContainer: HTMLDivElement;
	private _expandedAction: ShowCardAction = null;
	private _renderedActionCount: number = 0;
	private _statusCard: HTMLElement = null;
	private _actionCard: HTMLElement = null;

	private refreshContainer() {
		this._actionCardContainer.innerHTML = "";

		if (this._actionCard === null && this._statusCard === null) {
			this._actionCardContainer.style.padding = "0px";
			this._actionCardContainer.style.marginTop = "0px";

			return;
		}

		this._actionCardContainer.style.marginTop = this._renderedActionCount > 0 ? this._owner.hostConfig.actions.showCard.inlineTopMargin + "px" : "0px";

		let padding = this._owner.getEffectivePadding();

		this._owner.getImmediateSurroundingPadding(padding);

		let physicalPadding = this._owner.hostConfig.paddingDefinitionToSpacingDefinition(padding);

		if (this._actionCard !== null) {
			this._actionCard.style.paddingLeft = physicalPadding.left + "px";
			this._actionCard.style.paddingRight = physicalPadding.right + "px";

			this._actionCard.style.marginLeft = "-" + physicalPadding.left + "px";
			this._actionCard.style.marginRight = "-" + physicalPadding.right + "px";

			Utils.appendChild(this._actionCardContainer, this._actionCard);
		}

		if (this._statusCard !== null) {
			this._statusCard.style.paddingLeft = physicalPadding.left + "px";
			this._statusCard.style.paddingRight = physicalPadding.right + "px";

			this._statusCard.style.marginLeft = "-" + physicalPadding.left + "px";
			this._statusCard.style.marginRight = "-" + physicalPadding.right + "px";

			Utils.appendChild(this._actionCardContainer, this._statusCard);
		}
	}

	private layoutChanged() {
		this._owner.getRootElement().updateLayout();
	}

	private hideActionCard() {
		var previouslyExpandedAction = this._expandedAction;

		this._expandedAction = null;
		this._actionCard = null;

		this.refreshContainer();

		if (previouslyExpandedAction) {
			this.layoutChanged();

			raiseInlineCardExpandedEvent(previouslyExpandedAction, false);
		}
	}

	private showActionCard(action: ShowCardAction, suppressStyle: boolean = false, raiseEvent: boolean = true) {
		if (action.card == null) {
			return;
		}

		(<InlineAdaptiveCard>action.card).suppressStyle = suppressStyle;

		var renderedCard = action.card.render();

		this._actionCard = renderedCard;
		this._expandedAction = action;

		this.refreshContainer();

		if (raiseEvent) {
			this.layoutChanged();

			raiseInlineCardExpandedEvent(action, true);
		}
	}

	private collapseExpandedAction() {
		for (var i = 0; i < this.buttons.length; i++) {
			this.buttons[i].state = ActionButtonState.Normal;
		}

		this.hideActionCard();
	}

	private expandShowCardAction(action: ShowCardAction, raiseEvent: boolean) {
		for (var i = 0; i < this.buttons.length; i++) {
			if (this.buttons[i].action !== action) {
				this.buttons[i].state = ActionButtonState.Subdued;
			}
			else {
				this.buttons[i].state = ActionButtonState.Expanded;
			}
		}

		this.showActionCard(
			action,
			!(this._owner.isAtTheVeryLeft() && this._owner.isAtTheVeryRight()),
			raiseEvent);
	}

	private actionClicked(actionButton: ActionButton) {
		if (!(actionButton.action instanceof ShowCardAction)) {
			for (var i = 0; i < this.buttons.length; i++) {
				this.buttons[i].state = ActionButtonState.Normal;
			}

			this.hideStatusCard();
			this.hideActionCard();

			actionButton.action.execute();
		}
		else {
			this.hideStatusCard();

			if (this._owner.hostConfig.actions.showCard.actionMode === Enums.ShowCardActionMode.Popup) {
				actionButton.action.execute();
			}
			else if (actionButton.action === this._expandedAction) {
				this.collapseExpandedAction();
			}
			else {
				this.expandShowCardAction(actionButton.action, true);
			}
		}
	}

	private getParentContainer(): Container {
		if (this._owner instanceof Container) {
			return this._owner;
		}
		else {
			return this._owner.getParentContainer();
		}
	}

	private findActionButton(action: Action): ActionButton {
		for (let actionButton of this.buttons) {
			if (actionButton.action == action) {
				return actionButton;
			}
		}

		return null;
	}

	items: Array<Action> = [];
	buttons: Array<ActionButton> = [];

	constructor(owner: CardElement) {
		this._owner = owner;
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		this.clear();

		if (json && json instanceof Array) {
			for (let jsonAction of json) {
				let action = createActionInstance(
					this._owner,
					jsonAction,
					errors);

				if (action) {
					this.addAction(action);
				}
			}
		}
	}

	toJSON() {
		if (this.items.length > 0) {
			let result = [];

			for (let action of this.items) {
				result.push(action.toJSON());
			}

			return result;
		}
		else {
			return null;
		}
	}

	showStatusCard(status: AdaptiveCard) {
		status.setParent(this._owner);

		this._statusCard = status.render();

		this.refreshContainer();
	}

	hideStatusCard() {
		this._statusCard = null;

		this.refreshContainer();
	}

	getActionById(id: string): Action {
		var result: Action = null;

		for (var i = 0; i < this.items.length; i++) {
			result = this.items[i].getActionById(id);

			if (result) {
				break;
			}
		}

		return result;
	}

	validate(): Array<HostConfig.IValidationError> {
		var result: Array<HostConfig.IValidationError> = [];

		if (this._owner.hostConfig.actions.maxActions && this.items.length > this._owner.hostConfig.actions.maxActions) {
			result.push(
				{
					error: Enums.ValidationError.TooManyActions,
					message: "A maximum of " + this._owner.hostConfig.actions.maxActions + " actions are allowed."
				});
		}

		if (this.items.length > 0 && !this._owner.hostConfig.supportsInteractivity) {
			result.push(
				{
					error: Enums.ValidationError.InteractivityNotAllowed,
					message: "Interactivity is not allowed."
				});
		}

		for (var i = 0; i < this.items.length; i++) {
			if (!isActionAllowed(this.items[i], this._owner.getForbiddenActionTypes())) {
				result.push(
					{
						error: Enums.ValidationError.ActionTypeNotAllowed,
						message: "Actions of type " + this.items[i].getJsonTypeName() + " are not allowe."
					});
			}

		}

		for (var i = 0; i < this.items.length; i++) {
			result = result.concat(this.items[i].validate());
		}

		return result;
	}

	render(orientation: Enums.Orientation, isDesignMode: boolean): HTMLElement {
		if (!this._owner.hostConfig.supportsInteractivity) {
			return null;
		}

		let element = document.createElement("div");
		let maxActions = this._owner.hostConfig.actions.maxActions ? Math.min(this._owner.hostConfig.actions.maxActions, this.items.length) : this.items.length;
		let forbiddenActionTypes = this._owner.getForbiddenActionTypes();

		this._actionCardContainer = document.createElement("div");
		this._renderedActionCount = 0;

		if (this._owner.hostConfig.actions.preExpandSingleShowCardAction && maxActions == 1 && this.items[0] instanceof ShowCardAction && isActionAllowed(this.items[0], forbiddenActionTypes)) {
			this.showActionCard(<ShowCardAction>this.items[0], true);
			this._renderedActionCount = 1;
		}
		else {
			let buttonStrip = document.createElement("div");
			buttonStrip.className = this._owner.hostConfig.makeCssClassName("ac-actionSet");
			buttonStrip.style.display = "flex";

			if (orientation == Enums.Orientation.Horizontal) {
				buttonStrip.style.flexDirection = "row";

				if (this._owner.horizontalAlignment && this._owner.hostConfig.actions.actionAlignment != Enums.ActionAlignment.Stretch) {
					switch (this._owner.horizontalAlignment) {
						case Enums.HorizontalAlignment.Center:
							buttonStrip.style.justifyContent = "center";
							break;
						case Enums.HorizontalAlignment.Right:
							buttonStrip.style.justifyContent = "flex-end";
							break;
						default:
							buttonStrip.style.justifyContent = "flex-start";
							break;
					}
				}
				else {
					switch (this._owner.hostConfig.actions.actionAlignment) {
						case Enums.ActionAlignment.Center:
							buttonStrip.style.justifyContent = "center";
							break;
						case Enums.ActionAlignment.Right:
							buttonStrip.style.justifyContent = "flex-end";
							break;
						default:
							buttonStrip.style.justifyContent = "flex-start";
							break;
					}
				}
			}
			else {
				buttonStrip.style.flexDirection = "column";

				if (this._owner.horizontalAlignment && this._owner.hostConfig.actions.actionAlignment != Enums.ActionAlignment.Stretch) {
					switch (this._owner.horizontalAlignment) {
						case Enums.HorizontalAlignment.Center:
							buttonStrip.style.alignItems = "center";
							break;
						case Enums.HorizontalAlignment.Right:
							buttonStrip.style.alignItems = "flex-end";
							break;
						default:
							buttonStrip.style.alignItems = "flex-start";
							break;
					}
				}
				else {
					switch (this._owner.hostConfig.actions.actionAlignment) {
						case Enums.ActionAlignment.Center:
							buttonStrip.style.alignItems = "center";
							break;
						case Enums.ActionAlignment.Right:
							buttonStrip.style.alignItems = "flex-end";
							break;
						case Enums.ActionAlignment.Stretch:
							buttonStrip.style.alignItems = "stretch";
							break;
						default:
							buttonStrip.style.alignItems = "flex-start";
							break;
					}
				}
			}

			let parentContainerStyle = this.getParentContainer().style;

			for (let i = 0; i < this.items.length; i++) {
				if (isActionAllowed(this.items[i], forbiddenActionTypes)) {
					let actionButton: ActionButton = this.findActionButton(this.items[i]);

					if (!actionButton) {
						actionButton = new ActionButton(this.items[i], parentContainerStyle);
						actionButton.onClick = (ab) => { this.actionClicked(ab); };

						this.buttons.push(actionButton);
					}

					actionButton.render(this._owner.hostConfig.actions.actionAlignment);

					buttonStrip.appendChild(actionButton.action.renderedElement);

					this._renderedActionCount++;

					if (this._renderedActionCount >= this._owner.hostConfig.actions.maxActions || i == this.items.length - 1) {
						break;
					}
					else if (this._owner.hostConfig.actions.buttonSpacing > 0) {
						var spacer = document.createElement("div");

						if (orientation === Enums.Orientation.Horizontal) {
							spacer.style.flex = "0 0 auto";
							spacer.style.width = this._owner.hostConfig.actions.buttonSpacing + "px";
						}
						else {
							spacer.style.height = this._owner.hostConfig.actions.buttonSpacing + "px";
						}

						Utils.appendChild(buttonStrip, spacer);
					}
				}
			}

			let buttonStripContainer = document.createElement("div");
			buttonStripContainer.style.overflow = "hidden";
			buttonStripContainer.appendChild(buttonStrip);

			Utils.appendChild(element, buttonStripContainer);
		}

		Utils.appendChild(element, this._actionCardContainer);

		for (let i = 0; i < this.buttons.length; i++) {
			if (this.buttons[i].state == ActionButtonState.Expanded) {
				this.expandShowCardAction(<ShowCardAction>this.buttons[i].action, false);

				break;
			}
		}

		return this._renderedActionCount > 0 ? element : null;
	}

	addAction(action: Action) {
		if (!action) {
			throw new Error("The action parameter cannot be null.");
		}

		if ((!action.parent || action.parent === this._owner) && this.items.indexOf(action) < 0) {
			this.items.push(action);

			if (!action.parent) {
				action.setParent(this._owner);
			}

			invokeSetCollection(action, this);
		}
		else {
			throw new Error("The action already belongs to another element.");
		}
	}

	removeAction(action: Action): boolean {
		if (this.expandedAction && this._expandedAction == action) {
			this.collapseExpandedAction();
		}

		var actionIndex = this.items.indexOf(action);

		if (actionIndex >= 0) {
			this.items.splice(actionIndex, 1);

			action.setParent(null);

			invokeSetCollection(action, null);

			for (let i = 0; i < this.buttons.length; i++) {
				if (this.buttons[i].action == action) {
					this.buttons.splice(i, 1);

					break;
				}
			}

			return true;
		}

		return false;
	}

	clear() {
		this.items = [];
		this.buttons = [];

		this._expandedAction = null;
		this._renderedActionCount = 0;
	}

	getAllInputs(): Array<Input> {
		var result: Array<Input> = [];

		for (var i = 0; i < this.items.length; i++) {
			var action = this.items[i];

			result = result.concat(action.getAllInputs());
		}

		return result;
	}

	getResourceInformation(): Array<Shared.IResourceInformation> {
		let result: Array<Shared.IResourceInformation> = [];

		for (var i = 0; i < this.items.length; i++) {
			result = result.concat(this.items[i].getResourceInformation());
		}

		return result;
	}

	get renderedActionCount(): number {
		return this._renderedActionCount;
	}

	get expandedAction(): ShowCardAction {
		return this._expandedAction;
	}
}

export class ActionSet extends CardElement {
	private _actionCollection: ActionCollection;

	protected internalRender(): HTMLElement {
		return this._actionCollection.render(this.orientation ? this.orientation : this.hostConfig.actions.actionsOrientation, this.isDesignMode());
	}

	orientation?: Enums.Orientation = null;

	constructor() {
		super();

		this._actionCollection = new ActionCollection(this);
	}

	toJSON() {
		let result = super.toJSON();

		Utils.setEnumProperty(Enums.Orientation, result, "orientation", this.orientation);
		Utils.setProperty(result, "actions", this._actionCollection.toJSON());

		return result;
	}

	isBleedingAtBottom(): boolean {
		if (this._actionCollection.renderedActionCount == 0) {
			return super.isBleedingAtBottom();
		}
		else {
			if (this._actionCollection.items.length == 1) {
				return this._actionCollection.expandedAction != null && !this.hostConfig.actions.preExpandSingleShowCardAction;
			}
			else {
				return this._actionCollection.expandedAction != null;
			}
		}
	}

	getJsonTypeName(): string {
		return "ActionSet";
	}

	getActionCount(): number {
		return this._actionCollection.items.length;
	}

	getActionAt(index: number): Action {
		if (index >= 0 && index < this.getActionCount()) {
			return this._actionCollection.items[index];
		}
		else {
			super.getActionAt(index);
		}
	}

	validate(): Array<HostConfig.IValidationError> {
		return this._actionCollection.validate();
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		var jsonOrientation = json["orientation"];

		if (jsonOrientation) {
			this.orientation = Utils.getEnumValueOrDefault(Enums.Orientation, jsonOrientation, Enums.Orientation.Horizontal);
		}

		this._actionCollection.parse(json["actions"], errors);
	}

	addAction(action: Action) {
		this._actionCollection.addAction(action);
	}

	getAllInputs(): Array<Input> {
		return this._actionCollection.getAllInputs();
	}

	getResourceInformation(): Array<Shared.IResourceInformation> {
		return this._actionCollection.getResourceInformation();
	}

	renderSpeech(): string {
		// TODO: What's the right thing to do here?
		return "";
	}

	get isInteractive(): boolean {
		return true;
	}
}

export abstract class StylableCardElementContainer extends CardElementContainer {
	private _style?: string = null;
	private _bleed: boolean = false;

	protected applyBackground() {
		let styleDefinition = this.hostConfig.containerStyles.getStyleByName(this.style, this.hostConfig.containerStyles.getStyleByName(this.defaultStyle));

		if (!Utils.isNullOrEmpty(styleDefinition.backgroundColor)) {
			this.renderedElement.style.backgroundColor = Utils.stringToCssColor(styleDefinition.backgroundColor);
		}
	}

	protected applyPadding() {
		if (!this.renderedElement) {
			return;
		}

		let physicalPadding = new Shared.SpacingDefinition();

		if (this.getEffectivePadding()) {
			physicalPadding = this.hostConfig.paddingDefinitionToSpacingDefinition(this.getEffectivePadding());
		}

		this.renderedElement.style.paddingTop = physicalPadding.top + "px";
		this.renderedElement.style.paddingRight = physicalPadding.right + "px";
		this.renderedElement.style.paddingBottom = physicalPadding.bottom + "px";
		this.renderedElement.style.paddingLeft = physicalPadding.left + "px";

		if (this.isBleeding()) {
			// Bleed into the first parent that does have padding
			let padding = new Shared.PaddingDefinition();

			this.getImmediateSurroundingPadding(padding);
	
			let physicalPadding = this.hostConfig.paddingDefinitionToSpacingDefinition(padding);

			this.renderedElement.style.marginRight = "-" + physicalPadding.right + "px";
			this.renderedElement.style.marginLeft = "-" + physicalPadding.left + "px";

			if (this.separatorElement && this.separatorOrientation == Enums.Orientation.Horizontal) {
				this.separatorElement.style.marginLeft = "-" + physicalPadding.left + "px";
				this.separatorElement.style.marginRight = "-" + physicalPadding.right + "px";
			}
		}
		else {
			this.renderedElement.style.marginRight = "0";
			this.renderedElement.style.marginLeft = "0";

			if (this.separatorElement) {
				this.separatorElement.style.marginRight = "0";
				this.separatorElement.style.marginLeft = "0";
			}
		}

		if (!this.isDesignMode()) {
			let item = this.getFirstVisibleRenderedItem();

			if (item && item.isBleedingAtTop()) {
				this.renderedElement.style.paddingTop = "0px";
			}

			item = this.getLastVisibleRenderedItem();

			if (this.getHasExpandedAction() || (item && item.isBleedingAtBottom())) {
				this.renderedElement.style.paddingBottom = "0px";
			}
		}
	}

	protected getHasBackground(): boolean {
		let parentContainer = this.getParentContainer();

		return this.hasExplicitStyle && (parentContainer ? parentContainer.getEffectiveStyle() != this.getEffectiveStyle() : false);
	}

	protected getHasExpandedAction(): boolean {
		return false;
	}

	protected getDefaultPadding(): Shared.PaddingDefinition {
		return this.getHasBackground() ?
			new Shared.PaddingDefinition(
				Enums.Spacing.Padding,
				Enums.Spacing.Padding,
				Enums.Spacing.Padding,
				Enums.Spacing.Padding) : super.getDefaultPadding();
	}

	protected get hasExplicitStyle(): boolean {
		return this._style != null;
	}

	protected get defaultStyle(): string {
		return Enums.ContainerStyle.Default;
	}

	protected get allowCustomStyle(): boolean {
		return true;
	}

	protected getBleed(): boolean {
		return this._bleed;
	}

	protected setBleed(value: boolean) {
		this._bleed = value;
	}

	isBleeding(): boolean {
		return this.getHasBackground() && this.getBleed();
	}

	toJSON() {
		let result = super.toJSON();

		Utils.setProperty(result, "style", this.style);

		return result;
	}

	validate(): Array<HostConfig.IValidationError> {
		let result = super.validate();

		if (this._style) {
			let styleDefinition = this.hostConfig.containerStyles.getStyleByName(this._style);

			if (!styleDefinition) {
				result.push(
					{
						error: Enums.ValidationError.InvalidPropertyValue,
						message: "Unknown container style: " + this._style
					});
			}
		}

		return result;
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this._style = json["style"];
	}

	render(): HTMLElement {
		let renderedElement = super.render();

		if (renderedElement && this.getHasBackground()) {
			this.applyBackground();
		}

		return renderedElement;
	}

	getEffectiveStyle(): string {
		if (!this._style) {
			let parentContainer = this.getParentContainer();

			if (parentContainer) {
				return parentContainer.getEffectiveStyle();
			}
		}

		return this.style ? this.style : this.defaultStyle;
	}

	get style(): string {
		if (this.allowCustomStyle) {
			if (this._style && this.hostConfig.containerStyles.getStyleByName(this._style)) {
				return this._style;
			}
		}

		return null;
	}

	set style(value: string) {
		this._style = value;
	}
}

export class BackgroundImage {
	private static readonly defaultFillMode = Enums.FillMode.Cover;
	private static readonly defaultHorizontalAlignment = Enums.HorizontalAlignment.Left;
	private static readonly defaultVerticalAlignment = Enums.VerticalAlignment.Top;

	url: string;
	fillMode: Enums.FillMode = BackgroundImage.defaultFillMode;
	horizontalAlignment: Enums.HorizontalAlignment = BackgroundImage.defaultHorizontalAlignment;
	verticalAlignment: Enums.VerticalAlignment = BackgroundImage.defaultVerticalAlignment;

	reset() {
		this.url = undefined;
		this.fillMode = BackgroundImage.defaultFillMode;
		this.horizontalAlignment = BackgroundImage.defaultHorizontalAlignment;
		this.verticalAlignment = BackgroundImage.defaultVerticalAlignment;
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		this.url = json["url"];
		this.fillMode = Utils.getEnumValueOrDefault(Enums.FillMode, json["fillMode"], this.fillMode);
		this.horizontalAlignment = Utils.getEnumValueOrDefault(Enums.HorizontalAlignment, json["horizontalAlignment"], this.horizontalAlignment);
		this.verticalAlignment = Utils.getEnumValueOrDefault(Enums.VerticalAlignment, json["verticalAlignment"], this.verticalAlignment);
	}

	toJSON() {
		if (!this.isValid()) {
			return null;
		}
		
		if (this.fillMode == BackgroundImage.defaultFillMode &&
			this.horizontalAlignment == BackgroundImage.defaultHorizontalAlignment &&
			this.verticalAlignment == BackgroundImage.defaultVerticalAlignment) {
			return this.url;
		}
		else {
			let result = {};

			Utils.setProperty(result, "url", this.url);
			Utils.setEnumProperty(Enums.FillMode, result, "fillMode", this.fillMode, BackgroundImage.defaultFillMode);
			Utils.setEnumProperty(Enums.HorizontalAlignment, result, "horizontalAlignment", this.horizontalAlignment, BackgroundImage.defaultHorizontalAlignment);
			Utils.setEnumProperty(Enums.VerticalAlignment, result, "verticalAlignment", this.verticalAlignment, BackgroundImage.defaultVerticalAlignment);

			return result;
		}
	}

	apply(element: HTMLElement) {
		if (this.url) {
			element.style.backgroundImage = "url('" + this.url + "')";

			switch (this.fillMode) {
				case Enums.FillMode.Repeat:
					element.style.backgroundRepeat = "repeat";
					break;
				case Enums.FillMode.RepeatHorizontally:
					element.style.backgroundRepeat = "repeat-x";
					break;
				case Enums.FillMode.RepeatVertically:
					element.style.backgroundRepeat = "repeat-y";
					break;
				case Enums.FillMode.Cover:
				default:
					element.style.backgroundRepeat = "no-repeat";
					element.style.backgroundSize = "cover";
					break;
			}

			switch (this.horizontalAlignment) {
				case Enums.HorizontalAlignment.Center:
					element.style.backgroundPositionX = "center";
					break;
				case Enums.HorizontalAlignment.Right:
					element.style.backgroundPositionX = "right";
					break;
			}

			switch (this.verticalAlignment) {
				case Enums.VerticalAlignment.Center:
					element.style.backgroundPositionY = "center";
					break;
				case Enums.VerticalAlignment.Bottom:
					element.style.backgroundPositionY = "bottom";
					break;
			}
		}
	}

	isValid(): boolean {
		return !Utils.isNullOrEmpty(this.url);
	}
}

export class Container extends StylableCardElementContainer {
	private _items: Array<CardElement> = [];
	private _renderedItems: Array<CardElement> = [];

	private isElementAllowed(element: CardElement, forbiddenElementTypes: Array<string>) {
		if (!this.hostConfig.supportsInteractivity && element.isInteractive) {
			return false;
		}

		if (forbiddenElementTypes) {
			for (var i = 0; i < forbiddenElementTypes.length; i++) {
				if (element.getJsonTypeName() === forbiddenElementTypes[i]) {
					return false;
				}
			}
		}

		return true;
	}

	private insertItemAt(
		item: CardElement,
		index: number,
		forceInsert: boolean) {
		if (!item.parent || forceInsert) {
			if (item.isStandalone) {
				if (index < 0 || index >= this._items.length) {
					this._items.push(item);
				}
				else {
					this._items.splice(index, 0, item);
				}

				item.setParent(this);
			}
			else {
				throw new Error("Elements of type " + item.getJsonTypeName() + " cannot be used as standalone elements.");
			}
		}
		else {
			throw new Error("The element already belongs to another container.")
		}
	}

	protected supportsExcplitiHeight(): boolean {
		return true;
	}

	protected getItemsCollectionPropertyName(): string {
		return "items";
	}

	protected applyBackground() {
		if (this.backgroundImage.isValid()) {
			this.backgroundImage.apply(this.renderedElement);
		}

		super.applyBackground();
	}

	protected internalRender(): HTMLElement {
		this._renderedItems = [];

		// Cache hostConfig to avoid walking the parent hierarchy several times
		let hostConfig = this.hostConfig;

		var element = document.createElement("div");

		if (this.rtl != null && this.rtl) {
			element.dir = "rtl";
		}

		element.classList.add(hostConfig.makeCssClassName("ac-container"));
		element.style.display = "flex";
		element.style.flexDirection = "column";

		if (AdaptiveCard.useAdvancedCardBottomTruncation) {
			// Forces the container to be at least as tall as its content.
			//
			// Fixes a quirk in Chrome where, for nested flex elements, the
			// inner element's height would never exceed the outer element's
			// height. This caused overflow truncation to break -- containers
			// would always be measured as not overflowing, since their heights
			// were constrained by their parents as opposed to truly reflecting
			// the height of their content.
			//
			// See the "Browser Rendering Notes" section of this answer:
			// https://stackoverflow.com/questions/36247140/why-doesnt-flex-item-shrink-past-content-size
			element.style.minHeight = '-webkit-min-content';
		}

		switch (this.verticalContentAlignment) {
			case Enums.VerticalAlignment.Center:
				element.style.justifyContent = "center";
				break;
			case Enums.VerticalAlignment.Bottom:
				element.style.justifyContent = "flex-end";
				break;
			default:
				element.style.justifyContent = "flex-start";
				break;
		}

		if (this._items.length > 0) {
			for (var i = 0; i < this._items.length; i++) {
				var renderedElement = this.isElementAllowed(this._items[i], this.getForbiddenElementTypes()) ? this._items[i].render() : null;

				if (renderedElement) {
					if (this._renderedItems.length > 0 && this._items[i].separatorElement) {
						this._items[i].separatorElement.style.flex = "0 0 auto";

						Utils.appendChild(element, this._items[i].separatorElement);
					}

					Utils.appendChild(element, renderedElement);

					this._renderedItems.push(this._items[i]);
				}
			}
		}
		else {
			if (this.isDesignMode()) {
				var placeholderElement = this.createPlaceholderElement();
				placeholderElement.style.width = "100%";
				placeholderElement.style.height = "100%";

				element.appendChild(placeholderElement);
			}
		}

		return element;
	}

	protected truncateOverflow(maxHeight: number): boolean {
		// Add 1 to account for rounding differences between browsers
		var boundary = this.renderedElement.offsetTop + maxHeight + 1;

		var handleElement = (cardElement: CardElement) => {
			let elt = cardElement.renderedElement;

			if (elt) {
				switch (Utils.getFitStatus(elt, boundary)) {
					case Enums.ContainerFitStatus.FullyInContainer:
						let sizeChanged = cardElement['resetOverflow']();
						// If the element's size changed after resetting content,
						// we have to check if it still fits fully in the card
						if (sizeChanged) {
							handleElement(cardElement);
						}
						break;
					case Enums.ContainerFitStatus.Overflowing:
						let maxHeight = boundary - elt.offsetTop;
						cardElement['handleOverflow'](maxHeight);
						break;
					case Enums.ContainerFitStatus.FullyOutOfContainer:
						cardElement['handleOverflow'](0);
						break;
				}
			}
		};

		for (let item of this._items) {
			handleElement(item);
		}

		return true;
	}

	protected undoOverflowTruncation() {
		for (let item of this._items) {
			item['resetOverflow']();
		}
	}

	protected getHasBackground(): boolean {
		return this.backgroundImage.isValid() || super.getHasBackground();
	}

	protected get isSelectable(): boolean {
		return true;
	}

	readonly backgroundImage: BackgroundImage = new BackgroundImage();

	verticalContentAlignment: Enums.VerticalAlignment = Enums.VerticalAlignment.Top;
	rtl?: boolean = null;

	toJSON() {
		let result = super.toJSON();

		Utils.setProperty(result, "backgroundImage", this.backgroundImage.toJSON());

		Utils.setEnumProperty(Enums.VerticalAlignment, result, "verticalContentAlignment", this.verticalContentAlignment, Enums.VerticalAlignment.Top);

		if (this._items.length > 0) {
			let elements = [];

			for (let element of this._items) {
				elements.push(element.toJSON());
			}

			Utils.setProperty(result, this.getItemsCollectionPropertyName(), elements);
		}

		Utils.setProperty(result, "bleed", this.bleed);

		return result;
	}

	getItemCount(): number {
		return this._items.length;
	}

	getItemAt(index: number): CardElement {
		return this._items[index];
	}

	getFirstVisibleRenderedItem(): CardElement {
		if (this.renderedElement && this._renderedItems && this._renderedItems.length > 0) {
			for (let item of this._renderedItems) {
				if (item.isVisible) {
					return item;
				}
			};
		}
		
		return null;
	}

	getLastVisibleRenderedItem(): CardElement {
		if (this.renderedElement && this._renderedItems && this._renderedItems.length > 0) {
			for (let i = this._renderedItems.length - 1; i >= 0; i--) {
				if (this._renderedItems[i].isVisible) {
					return this._renderedItems[i];
				}
			}
		}

		return null;
	}

	getJsonTypeName(): string {
		return "Container";
	}

	isFirstElement(element: CardElement): boolean {
		for (var i = 0; i < this._items.length; i++) {
			if (this._items[i].isVisible) {
				return this._items[i] == element;
			}
		}

		return false;
	}

	isLastElement(element: CardElement): boolean {
		for (var i = this._items.length - 1; i >= 0; i--) {
			if (this._items[i].isVisible) {
				return this._items[i] == element;
			}
		}

		return false;
	}

	isRtl(): boolean {
		if (this.rtl != null) {
			return this.rtl;
		}
		else {
			let parentContainer = this.getParentContainer();

			return parentContainer ? parentContainer.isRtl() : false;
		}
	}

	isBleedingAtTop(): boolean {
		let firstRenderedItem = this.getFirstVisibleRenderedItem();

		return this.isBleeding() || (firstRenderedItem ? firstRenderedItem.isBleedingAtTop() : false);
	}

	isBleedingAtBottom(): boolean {
		let getLastRenderedItem = this.getLastVisibleRenderedItem();

		return this.isBleeding() || (getLastRenderedItem ? getLastRenderedItem.isBleedingAtBottom() : false);
	}

	validate(): Array<HostConfig.IValidationError> {
		let result = super.validate();

		for (var i = 0; i < this._items.length; i++) {
			if (!this.hostConfig.supportsInteractivity && this._items[i].isInteractive) {
				result.push(
					{
						error: Enums.ValidationError.InteractivityNotAllowed,
						message: "Interactivity is not allowed."
					});
			}

			if (!this.isElementAllowed(this._items[i], this.getForbiddenElementTypes())) {
				result.push(
					{
						error: Enums.ValidationError.InteractivityNotAllowed,
						message: "Elements of type " + this._items[i].getJsonTypeName() + " are not allowed in this container."
					});
			}

			result = result.concat(this._items[i].validate());
		}

		return result;
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this.setShouldFallback(false);

		this._items = [];
		this._renderedItems = [];

		let jsonBackgroundImage = json["backgroundImage"];

		if (jsonBackgroundImage) {
			this.backgroundImage.reset();

			if (typeof jsonBackgroundImage === "string") {
				this.backgroundImage.url = jsonBackgroundImage;
				this.backgroundImage.fillMode = Enums.FillMode.Cover;
			}
			else if (typeof jsonBackgroundImage === "object") {
				this.backgroundImage.parse(jsonBackgroundImage, errors);
			}
		}

		this.verticalContentAlignment = Utils.getEnumValueOrDefault(Enums.VerticalAlignment, json["verticalContentAlignment"], this.verticalContentAlignment);

		if (json[this.getItemsCollectionPropertyName()] != null) {
			let items = json[this.getItemsCollectionPropertyName()] as Array<any>;

			this.clear();

			for (let i = 0; i < items.length; i++) {
				let element = createElementInstance(this, items[i], errors);

				if (element) {
					this.insertItemAt(element, -1, true);
				}
			}
		}

		this.bleed = Utils.parseBoolProperty(json["bleed"], this.bleed);
	}

	indexOf(cardElement: CardElement): number {
		return this._items.indexOf(cardElement);
	}

	addItem(item: CardElement) {
		this.insertItemAt(item, -1, false);
	}

	insertItemBefore(item: CardElement, insertBefore: CardElement) {
		this.insertItemAt(item, this._items.indexOf(insertBefore), false);
	}

	insertItemAfter(item: CardElement, insertAfter: CardElement) {
		this.insertItemAt(item, this._items.indexOf(insertAfter) + 1, false);
	}

	removeItem(item: CardElement): boolean {
		var itemIndex = this._items.indexOf(item);

		if (itemIndex >= 0) {
			this._items.splice(itemIndex, 1);

			item.setParent(null);

			this.updateLayout();

			return true;
		}

		return false;
	}

	clear() {
		this._items = [];
	}

	getResourceInformation(): Array<Shared.IResourceInformation> {
		let result = super.getResourceInformation();

		if (this.backgroundImage.isValid()) {
			result.push({ url: this.backgroundImage.url, mimeType: "image" });
		}

		return result;
	}

	getActionById(id: string): Action {
		var result: Action = super.getActionById(id);

		if (!result) {
			if (this.selectAction) {
				result = this.selectAction.getActionById(id);
			}

			if (!result) {
				for (var i = 0; i < this._items.length; i++) {
					result = this._items[i].getActionById(id);

					if (result) {
						break;
					}
				}
			}
		}

		return result;
	}

	renderSpeech(): string {
		if (this.speak != null) {
			return this.speak;
		}

		// render each item
		let speak = null;

		if (this._items.length > 0) {
			speak = '';

			for (var i = 0; i < this._items.length; i++) {
				var result = this._items[i].renderSpeech();

				if (result) {
					speak += result;
				}
			}
		}

		return speak;
	}

	get bleed(): boolean {
		return this.getBleed();
	}

	set bleed(value: boolean) {
		this.setBleed(value);
	}

	get padding(): Shared.PaddingDefinition {
		return this.getPadding();
	}

	set padding(value: Shared.PaddingDefinition) {
		this.setPadding(value);
	}

	get selectAction(): Action {
		return this.getSelectAction();
	}

	set selectAction(value: Action) {
		this.setSelectAction(value);
	}
}

export type ColumnWidth = Shared.SizeAndUnit | "auto" | "stretch";

export class Column extends Container {
	private _computedWeight: number = 0;

	protected adjustRenderedElementSize(renderedElement: HTMLElement) {
		const minDesignTimeColumnHeight = 20;
		
		if (this.isDesignMode()) {
			renderedElement.style.minWidth = "20px";
			renderedElement.style.minHeight = (!this.minPixelHeight ? minDesignTimeColumnHeight : Math.max(this.minPixelHeight, minDesignTimeColumnHeight)) + "px";
		}
		else {
			renderedElement.style.minWidth = "0";

			if (this.minPixelHeight) {
				renderedElement.style.minHeight = this.minPixelHeight + "px";
			}
		}

		if (this.width === "auto") {
			renderedElement.style.flex = "0 1 auto";
		}
		else if (this.width === "stretch") {
			renderedElement.style.flex = "1 1 50px";
		}
		else {
			let sizeAndUnit = <Shared.SizeAndUnit>this.width;

			if (sizeAndUnit.unit == Enums.SizeUnit.Pixel) {
				renderedElement.style.flex = "0 0 auto";
				renderedElement.style.width = sizeAndUnit.physicalSize + "px";
			}
			else {
				renderedElement.style.flex = "1 1 " + (this._computedWeight > 0 ? this._computedWeight : sizeAndUnit.physicalSize) + "%";
			}
		}
	}

	protected getDefaultPadding(): Shared.PaddingDefinition {
		let columnSet = <ColumnSet>this.parent;
		let result = super.getDefaultPadding();

		result.top = (result.top == Enums.Spacing.None && columnSet.isBleedingAtTop() && columnSet.isAtTheVeryTop()) ? Enums.Spacing.Padding : result.top;
		result.right = (result.right == Enums.Spacing.None && columnSet.isBleeding() && columnSet.isAtTheVeryRight()) ? Enums.Spacing.Padding : result.right;
		result.bottom = (result.bottom == Enums.Spacing.None && columnSet.isBleedingAtBottom() && columnSet.isAtTheVeryBottom()) ? Enums.Spacing.Padding : result.bottom;
		result.left = (result.left == Enums.Spacing.None && columnSet.isBleeding() && columnSet.isAtTheVeryLeft()) ? Enums.Spacing.Padding : result.left;

		return result;
	}

	protected get separatorOrientation(): Enums.Orientation {
		return Enums.Orientation.Vertical;
	}

	width: ColumnWidth = "auto";

	constructor(width: ColumnWidth = "auto") {
		super();

		this.width = width;
	}

	getJsonTypeName(): string {
		return "Column";
	}

	toJSON() {
		let result = super.toJSON();

		if (this.width instanceof Shared.SizeAndUnit) {
			if (this.width.unit == Enums.SizeUnit.Pixel) {
				Utils.setProperty(result, "width", this.width.physicalSize + "px");
			}
			else {
				Utils.setProperty(result, "width", this.width.physicalSize);
			}
		}
		else {
			Utils.setProperty(result, "width", this.width);
		}

		return result;
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		var jsonWidth = json["width"];

		if (jsonWidth === undefined) {
			jsonWidth = json["size"];

			if (jsonWidth !== undefined) {
				raiseParseError(
					{
						error: Enums.ValidationError.Deprecated,
						message: "The \"Column.size\" property is deprecated and will be removed. Use the \"Column.width\" property instead."
					},
					errors
				);
			}
		}

		var invalidWidth = false;

		try {
			this.width = Shared.SizeAndUnit.parse(jsonWidth);
		}
		catch (e) {
			if (typeof jsonWidth === "string" && (jsonWidth === "auto" || jsonWidth === "stretch")) {
				this.width = jsonWidth;
			}
			else {
				invalidWidth = true;
			}
		}

		if (invalidWidth) {
			raiseParseError(
				{
					error: Enums.ValidationError.InvalidPropertyValue,
					message: "Invalid column width:" + jsonWidth + " - defaulting to \"auto\""
				},
				errors
			);
		}
	}

	get hasVisibleSeparator(): boolean {
		if (this.parent && this.parent instanceof ColumnSet) {
			return this.separatorElement && !this.parent.isLeftMostElement(this);
		}
		else {
			return false;
		}
	}

	get isStandalone(): boolean {
		return false;
	}
}

export class ColumnSet extends StylableCardElementContainer {
	private _columns: Array<Column> = [];
	private _renderedColumns: Array<Column>;

	protected internalRender(): HTMLElement {
		this._renderedColumns = [];

		if (this._columns.length > 0) {
			// Cache hostConfig to avoid walking the parent hierarchy several times
			let hostConfig = this.hostConfig;

			let element = document.createElement("div");
			element.className = hostConfig.makeCssClassName("ac-columnSet");
			element.style.display = "flex";

			if (AdaptiveCard.useAdvancedCardBottomTruncation) {
				// See comment in Container.internalRender()
				element.style.minHeight = '-webkit-min-content';
			}

			switch (this.horizontalAlignment) {
				case Enums.HorizontalAlignment.Center:
					element.style.justifyContent = "center";
					break;
				case Enums.HorizontalAlignment.Right:
					element.style.justifyContent = "flex-end";
					break;
				default:
					element.style.justifyContent = "flex-start";
					break;
			}

			let totalWeight: number = 0;

			for (let column of this._columns) {
				if (column.width instanceof Shared.SizeAndUnit && (column.width.unit == Enums.SizeUnit.Weight)) {
					totalWeight += column.width.physicalSize;
				}
			}

			for (let column of this._columns) {
				if (column.width instanceof Shared.SizeAndUnit && column.width.unit == Enums.SizeUnit.Weight && totalWeight > 0) {
					let computedWeight = 100 / totalWeight * column.width.physicalSize;

					// Best way to emulate "internal" access I know of
					column["_computedWeight"] = computedWeight;
				}

				let renderedColumn = column.render();

				if (renderedColumn) {
					if (this._renderedColumns.length > 0 && column.separatorElement) {
						column.separatorElement.style.flex = "0 0 auto";

						Utils.appendChild(element, column.separatorElement);
					}

					Utils.appendChild(element, renderedColumn);

					this._renderedColumns.push(column);
				}
			}

			return this._renderedColumns.length > 0 ? element : null;
		}
		else {
			return null;
		}
	}

	protected truncateOverflow(maxHeight: number): boolean {
		for (let column of this._columns) {
			column['handleOverflow'](maxHeight);
		}

		return true;
	}

	protected undoOverflowTruncation() {
		for (let column of this._columns) {
			column['resetOverflow']();
		}
	}

	protected get isSelectable(): boolean {
		return true;
	}

	toJSON() {
		let result = super.toJSON();

		if (this._columns.length > 0) {
			let columns = [];

			for (let column of this._columns) {
				columns.push(column.toJSON());
			}

			Utils.setProperty(result, "columns", columns);
		}

		Utils.setProperty(result, "bleed", this.bleed);

		return result;
	}

	isFirstElement(element: CardElement): boolean {
		for (var i = 0; i < this._columns.length; i++) {
			if (this._columns[i].isVisible) {
				return this._columns[i] == element;
			}
		}

		return false;
	}

	isBleedingAtTop(): boolean {
		if (this.isBleeding()) {
			return true;
		}

		if (this._renderedColumns && this._renderedColumns.length > 0) {
			for (let column of this._columns) {
				if (column.isBleedingAtTop()) {
					return true;
				}
			}
		}

		return false;
	}

	isBleedingAtBottom(): boolean {
		if (this.isBleeding()) {
			return true;
		}

		if (this._renderedColumns && this._renderedColumns.length > 0) {
			for (let column of this._columns) {
				if (column.isBleedingAtBottom()) {
					return true;
				}
			}
		}

		return false;
	}

	getCount(): number {
		return this._columns.length;
	}

	getItemCount(): number {
		return this.getCount();
	}

	getFirstVisibleRenderedItem(): CardElement {
		if (this.renderedElement && this._renderedColumns && this._renderedColumns.length > 0) {
			return this._renderedColumns[0];
		}
		else {
			return null;
		}
	}

	getLastVisibleRenderedItem(): CardElement {
		if (this.renderedElement && this._renderedColumns && this._renderedColumns.length > 0) {
			return this._renderedColumns[this._renderedColumns.length - 1];
		}
		else {
			return null;
		}
	}

	getColumnAt(index: number): Column {
		return this._columns[index];
	}

	getItemAt(index: number): CardElement {
		return this.getColumnAt(index);
	}

	getJsonTypeName(): string {
		return "ColumnSet";
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		if (json["columns"] != null) {
			let jsonColumns = json["columns"] as Array<any>;

			this._columns = [];

			for (let i = 0; i < jsonColumns.length; i++) {
				let column = new Column();
				column.setParent(this);
				column.parse(jsonColumns[i], errors);

				this._columns.push(column);
			}
		}

		this.bleed = Utils.parseBoolProperty(json["bleed"], this.bleed);
	}

	validate(): Array<HostConfig.IValidationError> {
		let result = super.validate();
		let weightedColumns: number = 0;
		let stretchedColumns: number = 0;

		for (var i = 0; i < this._columns.length; i++) {
			if (typeof this._columns[i].width === "number") {
				weightedColumns++;
			}
			else if (this._columns[i].width === "stretch") {
				stretchedColumns++;
			}
		}

		if (weightedColumns > 0 && stretchedColumns > 0) {
			result.push(
				{
					error: Enums.ValidationError.Hint,
					message: "It is not recommended to use weighted and stretched columns in the same ColumnSet, because in such a situation stretched columns will always get the minimum amount of space."
				});
		}

		return result;
	}

	addColumn(column: Column) {
		if (!column.parent) {
			this._columns.push(column);

			column.setParent(this);
		}
		else {
			throw new Error("This column already belongs to another ColumnSet.");
		}
	}

	removeItem(item: CardElement): boolean {
		if (item instanceof Column) {
			var itemIndex = this._columns.indexOf(item);

			if (itemIndex >= 0) {
				this._columns.splice(itemIndex, 1);

				item.setParent(null);

				this.updateLayout();

				return true;
			}
		}

		return false;
	}

	indexOf(cardElement: CardElement): number {
		return cardElement instanceof Column ? this._columns.indexOf(cardElement) : -1;
	}

	isLeftMostElement(element: CardElement): boolean {
		return this._columns.indexOf(<Column>element) == 0;
	}

	isRightMostElement(element: CardElement): boolean {
		return this._columns.indexOf(<Column>element) == this._columns.length - 1;
	}

	getActionById(id: string): Action {
		var result: Action = null;

		for (var i = 0; i < this._columns.length; i++) {
			result = this._columns[i].getActionById(id);

			if (result) {
				break;
			}
		}

		return result;
	}

	renderSpeech(): string {
		if (this.speak != null) {
			return this.speak;
		}

		// render each item
		let speak = '';

		if (this._columns.length > 0) {
			for (var i = 0; i < this._columns.length; i++) {
				speak += this._columns[i].renderSpeech();
			}
		}

		return speak;
	}

	get bleed(): boolean {
		return this.getBleed();
	}

	set bleed(value: boolean) {
		this.setBleed(value);
	}

	get padding(): Shared.PaddingDefinition {
		return this.getPadding();
	}

	set padding(value: Shared.PaddingDefinition) {
		this.setPadding(value);
	}

	get selectAction(): Action {
		return this.getSelectAction();
	}

	set selectAction(value: Action) {
		this.setSelectAction(value);
	}
}

function raiseImageLoadedEvent(image: Image) {
	let card = image.getRootElement() as AdaptiveCard;
	let onImageLoadedHandler = (card && card.onImageLoaded) ? card.onImageLoaded : AdaptiveCard.onImageLoaded;

	if (onImageLoadedHandler) {
		onImageLoadedHandler(image);
	}
}

function raiseAnchorClickedEvent(element: CardElement, anchor: HTMLAnchorElement): boolean {
	let card = element.getRootElement() as AdaptiveCard;
	let onAnchorClickedHandler = (card && card.onAnchorClicked) ? card.onAnchorClicked : AdaptiveCard.onAnchorClicked;

	return onAnchorClickedHandler != null ? onAnchorClickedHandler(element, anchor) : false;
}

function raiseExecuteActionEvent(action: Action) {
	let card = action.parent.getRootElement() as AdaptiveCard;
	let onExecuteActionHandler = (card && card.onExecuteAction) ? card.onExecuteAction : AdaptiveCard.onExecuteAction;

	if (onExecuteActionHandler) {
		action.prepare(action.parent.getRootElement().getAllInputs());

		onExecuteActionHandler(action);
	}
}

function raiseInlineCardExpandedEvent(action: ShowCardAction, isExpanded: boolean) {
	let card = action.parent.getRootElement() as AdaptiveCard;
	let onInlineCardExpandedHandler = (card && card.onInlineCardExpanded) ? card.onInlineCardExpanded : AdaptiveCard.onInlineCardExpanded;

	if (onInlineCardExpandedHandler) {
		onInlineCardExpandedHandler(action, isExpanded);
	}
}

function raiseElementVisibilityChangedEvent(element: CardElement, shouldUpdateLayout: boolean = true) {
	let rootElement = element.getRootElement();

	if (shouldUpdateLayout) {
		rootElement.updateLayout();
	}

	let card = rootElement as AdaptiveCard;
	let onElementVisibilityChangedHandler = (card && card.onElementVisibilityChanged) ? card.onElementVisibilityChanged : AdaptiveCard.onElementVisibilityChanged;

	if (onElementVisibilityChangedHandler != null) {
		onElementVisibilityChangedHandler(element);
	}
}

function raiseParseElementEvent(element: CardElement, json: any, errors?: Array<HostConfig.IValidationError>) {
	let card = element.getRootElement() as AdaptiveCard;
	let onParseElementHandler = (card && card.onParseElement) ? card.onParseElement : AdaptiveCard.onParseElement;

	if (onParseElementHandler != null) {
		onParseElementHandler(element, json, errors);
	}
}

function raiseParseActionEvent(action: Action, json: any, errors?: Array<HostConfig.IValidationError>) {
	let card = action.parent ? action.parent.getRootElement() as AdaptiveCard : null;
	let onParseActionHandler = (card && card.onParseAction) ? card.onParseAction : AdaptiveCard.onParseAction;

	if (onParseActionHandler != null) {
		onParseActionHandler(action, json, errors);
	}
}

function raiseParseError(error: HostConfig.IValidationError, errors: Array<HostConfig.IValidationError>) {
	if (errors) {
		errors.push(error);
	}

	if (AdaptiveCard.onParseError != null) {
		AdaptiveCard.onParseError(error);
	}
}

export interface ITypeRegistration<T> {
	typeName: string,
	createInstance: () => T;
}

export abstract class ContainerWithActions extends Container {
	private _actionCollection: ActionCollection;

	protected internalRender(): HTMLElement {
		var element = super.internalRender();

		var renderedActions = this._actionCollection.render(this.hostConfig.actions.actionsOrientation, false);

		if (renderedActions) {
			Utils.appendChild(
				element,
				Utils.renderSeparation(
					{
						spacing: this.hostConfig.getEffectiveSpacing(this.hostConfig.actions.spacing),
						lineThickness: null,
						lineColor: null
					},
					Enums.Orientation.Horizontal));
			Utils.appendChild(element, renderedActions);
		}

		if (this.renderIfEmpty) {
			return element;
		}
		else {
			return element.children.length > 0 ? element : null;
		}
	}

	protected getHasExpandedAction(): boolean {
		if (this._actionCollection.renderedActionCount == 0) {
			return false;
		}
		else if (this._actionCollection.items.length == 1) {
			return this._actionCollection.expandedAction != null && !this.hostConfig.actions.preExpandSingleShowCardAction;
		}
		else {
			return this._actionCollection.expandedAction != null;
		}
	}

	protected get renderIfEmpty(): boolean {
		return false;
	}

	constructor() {
		super();

		this._actionCollection = new ActionCollection(this);
	}

	toJSON() {
		let result = super.toJSON();

		Utils.setProperty(result, "actions", this._actionCollection.toJSON());

		return result;
	}

	getActionCount(): number {
		return this._actionCollection.items.length;
	}

	getActionAt(index: number): Action {
		if (index >= 0 && index < this.getActionCount()) {
			return this._actionCollection.items[index];
		}
		else {
			super.getActionAt(index);
		}
	}

	getActionById(id: string): Action {
		var result: Action = this._actionCollection.getActionById(id);

		return result ? result : super.getActionById(id);
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		super.parse(json, errors);

		this._actionCollection.parse(json["actions"]);
	}

	validate(): Array<HostConfig.IValidationError> {
		var result = super.validate();

		if (this._actionCollection) {
			result = result.concat(this._actionCollection.validate());
		}

		return result;
	}

	isLastElement(element: CardElement): boolean {
		return super.isLastElement(element) && this._actionCollection.items.length == 0;
	}

	addAction(action: Action) {
		this._actionCollection.addAction(action);
	}

	clear() {
		super.clear();

		this._actionCollection.clear();
	}

	getAllInputs(): Array<Input> {
		return super.getAllInputs().concat(this._actionCollection.getAllInputs());
	}

	getResourceInformation(): Array<Shared.IResourceInformation> {
		return super.getResourceInformation().concat(this._actionCollection.getResourceInformation());
	}

	isBleedingAtBottom(): boolean {
		if (this._actionCollection.renderedActionCount == 0) {
			return super.isBleedingAtBottom();
		}
		else {
			if (this._actionCollection.items.length == 1) {
				return this._actionCollection.expandedAction != null && !this.hostConfig.actions.preExpandSingleShowCardAction;
			}
			else {
				return this._actionCollection.expandedAction != null;
			}
		}
	}

	get isStandalone(): boolean {
		return false;
	}
}

export abstract class TypeRegistry<T> {
	private _items: Array<ITypeRegistration<T>> = [];

	private findTypeRegistration(typeName: string): ITypeRegistration<T> {
		for (var i = 0; i < this._items.length; i++) {
			if (this._items[i].typeName === typeName) {
				return this._items[i];
			}
		}

		return null;
	}

	constructor() {
		this.reset();
	}

	clear() {
		this._items = [];
	}

	abstract reset();

	registerType(typeName: string, createInstance: () => T) {
		var registrationInfo = this.findTypeRegistration(typeName);

		if (registrationInfo != null) {
			registrationInfo.createInstance = createInstance;
		}
		else {
			registrationInfo = {
				typeName: typeName,
				createInstance: createInstance
			}

			this._items.push(registrationInfo);
		}
	}

	unregisterType(typeName: string) {
		for (var i = 0; i < this._items.length; i++) {
			if (this._items[i].typeName === typeName) {
				this._items.splice(i, 1);

				return;
			}
		}
	}

	createInstance(typeName: string): T {
		var registrationInfo = this.findTypeRegistration(typeName);

		return registrationInfo ? registrationInfo.createInstance() : null;
	}

	getItemCount(): number {
		return this._items.length;
	}

	getItemAt(index: number): ITypeRegistration<T> {
		return this._items[index];
	}
}

export class ElementTypeRegistry extends TypeRegistry<CardElement> {
	reset() {
		this.clear();

		this.registerType("Container", () => { return new Container(); });
		this.registerType("TextBlock", () => { return new TextBlock(); });
		this.registerType("Image", () => { return new Image(); });
		this.registerType("ImageSet", () => { return new ImageSet(); });
		this.registerType("Media", () => { return new Media(); });
		this.registerType("FactSet", () => { return new FactSet(); });
		this.registerType("ColumnSet", () => { return new ColumnSet(); });
		this.registerType("ActionSet", () => { return new ActionSet(); });
		this.registerType("Input.Text", () => { return new TextInput(); });
		this.registerType("Input.Date", () => { return new DateInput(); });
		this.registerType("Input.Time", () => { return new TimeInput(); });
		this.registerType("Input.Number", () => { return new NumberInput(); });
		this.registerType("Input.ChoiceSet", () => { return new ChoiceSetInput(); });
		this.registerType("Input.Toggle", () => { return new ToggleInput(); });
	}
}

export class ActionTypeRegistry extends TypeRegistry<Action> {
	reset() {
		this.clear();

		this.registerType("Action.OpenUrl", () => { return new OpenUrlAction(); });
		this.registerType("Action.Submit", () => { return new SubmitAction(); });
		this.registerType("Action.ShowCard", () => { return new ShowCardAction(); });
		this.registerType("Action.ToggleVisibility", () => { return new ToggleVisibilityAction(); });
	}
}

export interface IMarkdownProcessingResult {
	didProcess: boolean;
	outputHtml?: any;
}

export class AdaptiveCard extends ContainerWithActions {
	private static currentVersion: HostConfig.Version = new HostConfig.Version(1, 1);

	static useAdvancedTextBlockTruncation: boolean = true;
	static useAdvancedCardBottomTruncation: boolean = false;
	static useMarkdownInRadioButtonAndCheckbox: boolean = true;
	static allowMarkForTextHighlighting: boolean = false;
	static alwaysBleedSeparators: boolean = false;

	static readonly elementTypeRegistry = new ElementTypeRegistry();
	static readonly actionTypeRegistry = new ActionTypeRegistry();

	static onAnchorClicked: (element: CardElement, anchor: HTMLAnchorElement) => boolean = null;
	static onExecuteAction: (action: Action) => void = null;
	static onElementVisibilityChanged: (element: CardElement) => void = null;
	static onImageLoaded: (image: Image) => void = null;
	static onInlineCardExpanded: (action: ShowCardAction, isExpanded: boolean) => void = null;
	static onParseElement: (element: CardElement, json: any, errors?: Array<HostConfig.IValidationError>) => void = null;
	static onParseAction: (element: Action, json: any, errors?: Array<HostConfig.IValidationError>) => void = null;
	static onParseError: (error: HostConfig.IValidationError) => void = null;
	static onProcessMarkdown: (text: string, result: IMarkdownProcessingResult) => void = null;

	static get processMarkdown(): (text: string) => string {
		throw new Error("The processMarkdown event has been removed. Please update your code and set onProcessMarkdown instead.")
	}

	static set processMarkdown(value: (text: string) => string) {
		throw new Error("The processMarkdown event has been removed. Please update your code and set onProcessMarkdown instead.")
	}

	static applyMarkdown(text: string): IMarkdownProcessingResult {
		let result: IMarkdownProcessingResult = {
			didProcess: false
		};

		if (AdaptiveCard.onProcessMarkdown) {
			AdaptiveCard.onProcessMarkdown(text, result);
		}
		else if (window["markdownit"]) {
			// Check for markdownit
			result.outputHtml = window["markdownit"]().render(text);
			result.didProcess = true;
		} else {
			console.warn("Markdown processing isn't enabled. Please see https://www.npmjs.com/package/adaptivecards#supporting-markdown")
		}

		return result;
	}

	private _cardTypeName?: string = "AdaptiveCard";
	private _fallbackCard: AdaptiveCard = null;

	private isVersionSupported(): boolean {
		if (this.bypassVersionCheck) {
			return true;
		}
		else {
			let unsupportedVersion: boolean =
				!this.version ||
				!this.version.isValid ||
				(AdaptiveCard.currentVersion.major < this.version.major) ||
				(AdaptiveCard.currentVersion.major == this.version.major && AdaptiveCard.currentVersion.minor < this.version.minor);

			return !unsupportedVersion;
		}
	}

	protected getItemsCollectionPropertyName(): string {
		return "body";
	}

	protected internalRender(): HTMLElement {
		var renderedElement = super.internalRender();

		if (AdaptiveCard.useAdvancedCardBottomTruncation) {
			// Unlike containers, the root card element should be allowed to
			// be shorter than its content (otherwise the overflow truncation
			// logic would never get triggered)
			renderedElement.style.minHeight = null;
		}

		return renderedElement;
	}

	protected getHasBackground(): boolean {
		return true;
	}

	protected getDefaultPadding(): Shared.PaddingDefinition {
		return new Shared.PaddingDefinition(
			Enums.Spacing.Padding,
			Enums.Spacing.Padding,
			Enums.Spacing.Padding,
			Enums.Spacing.Padding);
	}

	protected get renderIfEmpty(): boolean {
		return true;
	}

	protected get bypassVersionCheck(): boolean {
		return false;
	}

	protected get allowCustomPadding(): boolean {
		return false;
	}

	protected get allowCustomStyle() {
		return this.hostConfig.adaptiveCard && this.hostConfig.adaptiveCard.allowCustomStyle;
	}

	protected get hasBackground(): boolean {
		return true;
	}

	onAnchorClicked: (element: CardElement, anchor: HTMLAnchorElement) => boolean = null;
	onExecuteAction: (action: Action) => void = null;
	onElementVisibilityChanged: (element: CardElement) => void = null;
	onImageLoaded: (image: Image) => void = null;
	onInlineCardExpanded: (action: ShowCardAction, isExpanded: boolean) => void = null;
	onParseElement: (element: CardElement, json: any, errors?: Array<HostConfig.IValidationError>) => void = null;
	onParseAction: (element: Action, json: any, errors?: Array<HostConfig.IValidationError>) => void = null;

	version?: HostConfig.Version = new HostConfig.Version(1, 0);
	fallbackText: string;
	designMode: boolean = false;

	getJsonTypeName(): string {
		return "AdaptiveCard";
	}

	toJSON() {
		let result = super.toJSON();

		Utils.setProperty(result, "$schema", "http://adaptivecards.io/schemas/adaptive-card.json");

		if (!this.bypassVersionCheck && this.version) {
			Utils.setProperty(result, "version", this.version.toString());
		}

		Utils.setProperty(result, "fallbackText", this.fallbackText);
		Utils.setProperty(result, "lang", this.lang);
		Utils.setProperty(result, "speak", this.speak);

		return result;
	}

	validate(): Array<HostConfig.IValidationError> {
		var result: Array<HostConfig.IValidationError> = [];

		if (this._cardTypeName != "AdaptiveCard") {
			result.push(
				{
					error: Enums.ValidationError.MissingCardType,
					message: "Invalid or missing card type. Make sure the card's type property is set to \"AdaptiveCard\"."
				});
		}

		if (!this.bypassVersionCheck && !this.version) {
			result.push(
				{
					error: Enums.ValidationError.PropertyCantBeNull,
					message: "The version property must be specified."
				});
		}
		else if (!this.isVersionSupported()) {
			result.push(
				{
					error: Enums.ValidationError.UnsupportedCardVersion,
					message: "The specified card version (" + this.version + ") is not supported. The maximum supported card version is " + AdaptiveCard.currentVersion
				});
		}

		return result.concat(super.validate());
	}

	parse(json: any, errors?: Array<HostConfig.IValidationError>) {
		this._fallbackCard = null;

		this._cardTypeName = json["type"];

		var langId = json["lang"];

		if (langId && typeof langId === "string") {
			try {
				this.lang = langId;
			}
			catch (e) {
				raiseParseError(
					{
						error: Enums.ValidationError.InvalidPropertyValue,
						message: e.message
					},
					errors
				);
			}
		}

		this.version = HostConfig.Version.parse(json["version"], errors);

		this.fallbackText = json["fallbackText"];

		let fallbackElement = createElementInstance(null, json["fallback"], errors);

		if (fallbackElement) {
			this._fallbackCard = new AdaptiveCard();
			this._fallbackCard.addItem(fallbackElement);
		}

		super.parse(json, errors);
	}

	render(target?: HTMLElement): HTMLElement {
		let renderedCard: HTMLElement;

		if (this.shouldFallback()) {
			if (this._fallbackCard) {
				this._fallbackCard.hostConfig = this.hostConfig;

				renderedCard = this._fallbackCard.render();
			}
			else {
				let errorText = !Utils.isNullOrEmpty(this.fallbackText) ? this.fallbackText : "The card could not be rendered. It is either malformed or uses features not supported by this host.";

				try {
					let fallbackCard = new AdaptiveCard();
					fallbackCard.hostConfig = this.hostConfig;
					fallbackCard.parse(
						{
							type: "AdaptiveCard",
							version: "1.0",
							body: [
								{
									type: "TextBlock",
									text: errorText,
									wrap: true
								}
							]
						});

					renderedCard = fallbackCard.render();
				}
				catch (e) {
					renderedCard = document.createElement("div");
					renderedCard.innerHTML = errorText;
				}
			}
		}
		else {
			renderedCard = super.render();

			if (renderedCard) {
				renderedCard.tabIndex = 0;

				if (!Utils.isNullOrEmpty(this.speak)) {
					renderedCard.setAttribute("aria-label", this.speak);
				}
			}
		}

		if (target) {
			target.appendChild(renderedCard);

			this.updateLayout();
		}

		return renderedCard;
	}

	updateLayout(processChildren: boolean = true) {
		super.updateLayout(processChildren);

		if (AdaptiveCard.useAdvancedCardBottomTruncation && this.isRendered()) {
			var card = this.renderedElement;
			var padding = this.hostConfig.getEffectiveSpacing(Enums.Spacing.Default);

			this['handleOverflow'](card.offsetHeight - padding);
		}
	}

	shouldFallback(): boolean {
		return super.shouldFallback() || !this.isVersionSupported();
	}

	get hasVisibleSeparator(): boolean {
		return false;
	}
}

class InlineAdaptiveCard extends AdaptiveCard {
	protected getDefaultPadding(): Shared.PaddingDefinition {
		return new Shared.PaddingDefinition(
			this.suppressStyle ? Enums.Spacing.None : Enums.Spacing.Padding,
			Enums.Spacing.Padding,
			this.suppressStyle ? Enums.Spacing.None : Enums.Spacing.Padding,
			Enums.Spacing.Padding);
	}

	protected get bypassVersionCheck(): boolean {
		return true;
	}

	protected get defaultStyle(): string {
		if (this.suppressStyle) {
			return Enums.ContainerStyle.Default;
		}
		else {
			return this.hostConfig.actions.showCard.style ? this.hostConfig.actions.showCard.style : Enums.ContainerStyle.Emphasis;
		}
	}

	suppressStyle: boolean = false;

	render(target?: HTMLElement) {
		var renderedCard = super.render(target);
		renderedCard.setAttribute("aria-live", "polite");
		renderedCard.removeAttribute("tabindex");

		return renderedCard;
	}

	getForbiddenActionTypes(): Array<any> {
		return [ShowCardAction];
	}
}

const defaultHostConfig: HostConfig.HostConfig = new HostConfig.HostConfig(
	{
		supportsInteractivity: true,
		fontFamily: "Segoe UI",
		spacing: {
			small: 10,
			default: 20,
			medium: 30,
			large: 40,
			extraLarge: 50,
			padding: 20
		},
		separator: {
			lineThickness: 1,
			lineColor: "#EEEEEE"
		},
		fontSizes: {
			small: 12,
			default: 14,
			medium: 17,
			large: 21,
			extraLarge: 26
		},
		fontWeights: {
			lighter: 200,
			default: 400,
			bolder: 600
		},
		imageSizes: {
			small: 40,
			medium: 80,
			large: 160
		},
		containerStyles: {
			default: {
				backgroundColor: "#FFFFFF",
				foregroundColors: {
					default: {
						default: "#333333",
						subtle: "#EE333333"
					},
					dark: {
						default: "#000000",
						subtle: "#66000000"
					},
					light: {
						default: "#FFFFFF",
						subtle: "#33000000"
					},
					accent: {
						default: "#2E89FC",
						subtle: "#882E89FC"
					},
					attention: {
						default: "#cc3300",
						subtle: "#DDcc3300"
					},
					good: {
						default: "#54a254",
						subtle: "#DD54a254"
					},
					warning: {
						default: "#e69500",
						subtle: "#DDe69500"
					}
				}
			},
			emphasis: {
				backgroundColor: "#08000000",
				foregroundColors: {
					default: {
						default: "#333333",
						subtle: "#EE333333"
					},
					dark: {
						default: "#000000",
						subtle: "#66000000"
					},
					light: {
						default: "#FFFFFF",
						subtle: "#33000000"
					},
					accent: {
						default: "#2E89FC",
						subtle: "#882E89FC"
					},
					attention: {
						default: "#cc3300",
						subtle: "#DDcc3300"
					},
					good: {
						default: "#54a254",
						subtle: "#DD54a254"
					},
					warning: {
						default: "#e69500",
						subtle: "#DDe69500"
					}
				}
			}
		},
		actions: {
			maxActions: 5,
			spacing: Enums.Spacing.Default,
			buttonSpacing: 10,
			showCard: {
				actionMode: Enums.ShowCardActionMode.Inline,
				inlineTopMargin: 16
			},
			actionsOrientation: Enums.Orientation.Horizontal,
			actionAlignment: Enums.ActionAlignment.Left
		},
		adaptiveCard: {
			allowCustomStyle: false
		},
		imageSet: {
			imageSize: Enums.Size.Medium,
			maxImageHeight: 100
		},
		factSet: {
			title: {
				color: Enums.TextColor.Default,
				size: Enums.TextSize.Default,
				isSubtle: false,
				weight: Enums.TextWeight.Bolder,
				wrap: true,
				maxWidth: 150,
			},
			value: {
				color: Enums.TextColor.Default,
				size: Enums.TextSize.Default,
				isSubtle: false,
				weight: Enums.TextWeight.Default,
				wrap: true,
			},
			spacing: 10
		}
	});
