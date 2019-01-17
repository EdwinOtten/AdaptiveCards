#pragma once

#include "pch.h"
#include "json/json.h"
#include "SemanticVersion.h"

namespace AdaptiveSharedNamespace
{
    class ParseContext;

    template<typename T> class BaseElement
    {
    public:
        BaseElement() :
            m_requires(0), m_fallbackContent(nullptr), m_fallbackType(FallbackType::None),
            m_internalId(BaseElement::GetNextInternalId())
        {
        }

        FallbackType GetFallbackType() const { return m_fallbackType; }

        bool MeetsRequirements(const std::unordered_map<std::string, std::string>& /*hostProvides*/) const
        {
            return true;
        }

        std::shared_ptr<T> GetFallbackContent() const { return m_fallbackContent; }

        void SerializeFallbackAndRequires(Json::Value& root) const
        {
            SerializeFallback(root);
            SerializeRequires(root);
        }

        static void ParseFallbackAndRequires(ParseContext& context, const Json::Value& json, T& baseElement)
        {
            ParseFallback(context, json, baseElement);
            ParseRequires(context, json, baseElement);
        }


        unsigned int GetInternalId() const { return m_internalId; }

    private:
        void SerializeFallback(Json::Value& root) const
        {
            if (m_fallbackType == FallbackType::Drop)
            {
                root[AdaptiveCardSchemaKeyToString(AdaptiveCardSchemaKey::Fallback)] = "drop";
            }
            else if (m_fallbackType == FallbackType::Content)
            {
                root[AdaptiveCardSchemaKeyToString(AdaptiveCardSchemaKey::Fallback)] = m_fallbackContent->SerializeToJsonValue();
            }
        }

        void SerializeRequires(Json::Value& root) const
        {
            if (!m_requires.empty())
            {
                Json::Value jsonRequires{};
                for (const auto& requirement : m_requires)
                {
                    jsonRequires[requirement.first] = static_cast<std::string>(requirement.second);
                }

                root[AdaptiveCardSchemaKeyToString(AdaptiveCardSchemaKey::Requires)] = jsonRequires;
            }
        }

        static unsigned int GetNextInternalId()
        {
            static unsigned int nextId = 1;
            return nextId++;
        }

        static void ParseFallback(ParseContext& context, const Json::Value& json, T& baseElement)
        {
            const auto fallbackValue = ParseUtil::ExtractJsonValue(json, AdaptiveCardSchemaKey::Fallback, false);
            if (!fallbackValue.empty())
            {
                if (fallbackValue.isString())
                {
                    auto fallbackStringValue = ParseUtil::ToLowercase(fallbackValue.asString());
                    if (fallbackStringValue == "drop")
                    {
                        baseElement.m_fallbackType = FallbackType::Drop;
                        return;
                    }
                    throw AdaptiveCardParseException(ErrorStatusCode::InvalidPropertyValue,
                                                     "The only valid string value for the fallback property is 'drop'.");
                }
                else if (fallbackValue.isObject())
                {
                    // fallback value is a JSON object. parse it and add it as fallback content.
                    context.PushElement({baseElement.GetId(), baseElement.GetInternalId(), true});
                    std::shared_ptr<T> fallbackElement;
                    T::ParseJsonObject(context, fallbackValue, fallbackElement);

                    if (fallbackElement)
                    {
                        baseElement.m_fallbackType = FallbackType::Content;
                        baseElement.m_fallbackContent = fallbackElement;
                        context.PopElement();
                        return;
                    }
                    throw AdaptiveCardParseException(ErrorStatusCode::InvalidPropertyValue, "Fallback content did not parse correctly.");
                }
                throw AdaptiveCardParseException(ErrorStatusCode::InvalidPropertyValue, "Invalid value for fallback");
            }
        }

        static void ParseRequires(ParseContext& /*context*/, const Json::Value& json, T& baseElement)
        {
            const auto requiresValue = ParseUtil::ExtractJsonValue(json, AdaptiveCardSchemaKey::Requires, false);
            if (!requiresValue.isNull())
            {
                if (requiresValue.isObject())
                {
                    const auto& memberNames = requiresValue.getMemberNames();
                    const auto countNames = memberNames.size();
                    for (unsigned int i = 0; i < countNames; ++i)
                    {
                        const auto& memberName = memberNames[i];
                        const auto& memberValue = requiresValue[memberName].asString();
                        try
                        {
                            SemanticVersion memberVersion(memberValue);
                            baseElement.m_requires.emplace(memberName, memberVersion);
                        }
                        catch (const AdaptiveCardParseException&)
                        {
                            throw AdaptiveCardParseException(ErrorStatusCode::InvalidPropertyValue, "Invalid version in requires value: '" + memberValue + "'");
                        }
                    }
                    return;
                }
                throw AdaptiveCardParseException(ErrorStatusCode::InvalidPropertyValue, "Invalid value for requires (should be object)");
            }
        }

        std::unordered_map<std::string, SemanticVersion> m_requires;
        std::shared_ptr<T> m_fallbackContent;
        FallbackType m_fallbackType;
        const unsigned int m_internalId;
    };
}
