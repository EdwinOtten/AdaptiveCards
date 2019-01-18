#include "pch.h"
#include "BaseElement.h"
#include "ParseContext.h"

namespace AdaptiveSharedNamespace
{
    std::string BaseElement::Serialize() const
    {
        Json::FastWriter writer;
        return writer.write(SerializeToJsonValue());
    }

    std::string BaseElement::GetId() const
    {
        return m_id;
    }

    void BaseElement::SetId(const std::string& value)
    {
        m_id = value;
    }

    std::string BaseElement::GetElementTypeString() const
    {
        return m_typeString;
    }

    void BaseElement::SetElementTypeString(const std::string& value)
    {
        m_typeString = value;
    }

    Json::Value BaseElement::GetAdditionalProperties() const
    {
        return m_additionalProperties;
    }

    void BaseElement::SetAdditionalProperties(Json::Value const& value)
    {
        m_additionalProperties = value;
    }

    Json::Value BaseElement::SerializeToJsonValue() const
    {
        Json::Value root = GetAdditionalProperties();

        if (!m_id.empty())
        {
            root[AdaptiveCardSchemaKeyToString(AdaptiveCardSchemaKey::Id)] = m_id;
        }

        // Handle fallback
        if (m_fallbackType == FallbackType::Drop)
        {
            root[AdaptiveCardSchemaKeyToString(AdaptiveCardSchemaKey::Fallback)] = "drop";
        }
        else if (m_fallbackType == FallbackType::Content)
        {
            root[AdaptiveCardSchemaKeyToString(AdaptiveCardSchemaKey::Fallback)] = m_fallbackContent->SerializeToJsonValue();
        }

        // Handle requires
        if (!m_requires.empty())
        {
            Json::Value jsonRequires{};
            for (const auto& requirement : m_requires)
            {
                jsonRequires[requirement.first] = static_cast<std::string>(requirement.second);
            }

            root[AdaptiveCardSchemaKeyToString(AdaptiveCardSchemaKey::Requires)] = jsonRequires;
        }

        return root;
    }

    void BaseElement::GetResourceInformation(std::vector<RemoteResourceInformation>& /*resourceInfo*/)
    {
        return;
    }

    void BaseElement::ParseRequires(ParseContext& /*context*/, const Json::Value& json)
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
                        m_requires.emplace(memberName, memberVersion);
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
}
