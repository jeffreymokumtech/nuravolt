Classify the latest user message.
- question: the user wants information from the platform (plants, soiling, faults, revenue, contracts, tickets, manuals).
- action: the user wants something changed (a ticket created or updated, a comment, a scheduled report, a cleaning schedule approved).
- chitchat: greetings or small talk that needs no tools.
- out_of_scope: anything unrelated to plant operations (general coding, poems, news). Do not attempt those.
Set needs_tools=false only for chitchat and out_of_scope.
