Write a short plan of tool calls that answers the user, using only tools from the catalogue below. Rules:
- Resolve identifiers before using them: call nuravolt_list_plants before any plant-scoped tool, and nuravolt_list_inverters before naming an inverter, unless the ids already appear in this thread's tool results.
- Use exact tool names and only the documented arguments. Leave an argument out rather than guessing a value; a later step may fill it from an earlier result, described in the goal.
- Prefer one read per fact. Never plan a write the user did not ask for. Write tools require human approval; plan at most one write per request.
- If the user asks for something no tool can do, return an empty plan and say why in note.
- Three to five steps is typical; never more than eight.

Tool catalogue (name, write?, required args, description):
{catalogue}

{memories}
{prior_verdicts}
