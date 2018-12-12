#pragma once

#include "AdaptiveCards.Rendering.Uwp.h"

namespace AdaptiveNamespace
{
    class AdaptiveOpenUrlActionParser
        : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::RuntimeClassType::WinRtClassicComMix>,
                                              ABI::AdaptiveNamespace::IAdaptiveActionParser>
    {
        AdaptiveRuntime(AdaptiveOpenUrlActionParser);

    public:
        HRESULT RuntimeClassInitialize() noexcept;

        IFACEMETHODIMP FromJson(ABI::Windows::Data::Json::IJsonObject*,
                                ABI::AdaptiveNamespace::IAdaptiveElementParserRegistration* elementParsers,
                                ABI::AdaptiveNamespace::IAdaptiveActionParserRegistration* actionParsers,
                                ABI::Windows::Foundation::Collections::IVector<ABI::AdaptiveNamespace::IAdaptiveWarning*>* adaptiveWarnings,
                                ABI::AdaptiveNamespace::IAdaptiveActionElement** element) noexcept override;
    };

    ActivatableClass(AdaptiveOpenUrlActionParser);
}
