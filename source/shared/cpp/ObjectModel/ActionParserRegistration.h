#pragma once

#include "pch.h"
#include "Enums.h"
#include "json/json.h"

namespace AdaptiveSharedNamespace
{
    class BaseActionElement;
    class ParseContext;

    class ActionElementParser
    {
    public:
        ActionElementParser() = default;
        ActionElementParser(const ActionElementParser&) = default;
        ActionElementParser(ActionElementParser&&) = default;
        ActionElementParser& operator=(const ActionElementParser&) = default;
        ActionElementParser& operator=(ActionElementParser&&) = default;
        virtual ~ActionElementParser() = default;

        virtual std::shared_ptr<BaseActionElement> Deserialize(ParseContext& context, const Json::Value& value) = 0;
    };

    class ActionParserRegistration final
    {
    public:
        ActionParserRegistration();

        void AddParser(std::string const& elementType, std::shared_ptr<AdaptiveSharedNamespace::ActionElementParser> parser);
        void RemoveParser(std::string const& elementType);
        std::shared_ptr<AdaptiveSharedNamespace::ActionElementParser> GetParser(std::string const& elementType) const;

    private:
        std::unordered_set<std::string> m_knownElements;
        std::unordered_map<std::string, std::shared_ptr<AdaptiveSharedNamespace::ActionElementParser>, CaseInsensitiveHash, CaseInsensitiveEqualTo> m_cardElementParsers;
    };
}
