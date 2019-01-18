#pragma once

#include "pch.h"
#include "Enums.h"
#include "json/json.h"
#include "RemoteResourceInformation.h"
#include "BaseElement.h"

namespace AdaptiveSharedNamespace
{
    class BaseActionElement : public BaseElement
    {
    public:
        BaseActionElement(ActionType type);

        BaseActionElement() = default;
        BaseActionElement(const BaseActionElement&) = default;
        BaseActionElement(BaseActionElement&&) = default;
        BaseActionElement& operator=(const BaseActionElement&) = default;
        BaseActionElement& operator=(BaseActionElement&&) = default;
        ~BaseActionElement() = default;

        virtual std::string GetTitle() const;
        virtual void SetTitle(const std::string& value);

        virtual std::string GetIconUrl() const;
        virtual void SetIconUrl(const std::string& value);

        virtual Sentiment GetSentiment() const;
        virtual void SetSentiment(const Sentiment& value);

        virtual const ActionType GetElementType() const;

        void GetResourceInformation(std::vector<RemoteResourceInformation>& resourceUris) override;
        Json::Value SerializeToJsonValue() const override;

        template <typename T>
        static std::shared_ptr<T> Deserialize(ParseContext& context, const Json::Value& json);

        static void ParseJsonObject(AdaptiveSharedNamespace::ParseContext& context, const Json::Value& json, std::shared_ptr<BaseElement>& element);

    protected:
        std::unordered_set<std::string> m_knownProperties;

    private:
        virtual void PopulateKnownPropertiesSet();

        std::string m_title;
        std::string m_iconUrl;
        ActionType m_type;
        Sentiment m_sentiment;
    };

    template <typename T>
    std::shared_ptr<T> BaseActionElement::Deserialize(ParseContext& context, const Json::Value& json)
    {
        std::shared_ptr<T> cardElement = std::make_shared<T>();
        std::shared_ptr<BaseActionElement> baseActionElement = std::static_pointer_cast<BaseActionElement>(cardElement);

        ParseUtil::ThrowIfNotJsonObject(json);

        baseActionElement->DeserializeBase<BaseActionElement>(context, json);

        baseActionElement->SetIconUrl(ParseUtil::GetString(json, AdaptiveCardSchemaKey::IconUrl));
        baseActionElement->SetSentiment(
            ParseUtil::GetEnumValue<Sentiment>(json, AdaptiveCardSchemaKey::Sentiment, Sentiment::Default, SentimentFromString));
        baseActionElement->SetTitle(ParseUtil::GetString(json, AdaptiveCardSchemaKey::Title));

        // Walk all properties and put any unknown ones in the additional properties json
        for (auto it = json.begin(); it != json.end(); ++it)
        {
            std::string key = it.key().asCString();
            if (baseActionElement->m_knownProperties.find(key) == baseActionElement->m_knownProperties.end())
            {
                baseActionElement->m_additionalProperties[key] = *it;
            }
        }
        return cardElement;
    }
}
