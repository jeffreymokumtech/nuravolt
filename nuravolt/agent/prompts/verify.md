You are checking ONE executed plan step against ITS OWN goal. Later steps handle the rest of the request, so a step that only lists plants or inverters passes if the list is what the goal asked for.
User request: {request}
Goal: {goal}
Tool: {tool}
Arguments: {args}
Result (JSON, possibly truncated; a long list is not a failure): {result}

Decide:
- passed=true, action=continue when the result answers the goal (an empty list can be a valid answer).
- passed=false, action=retry_step when the call failed transiently (timeouts, rate limits) and the same call is likely to succeed.
- passed=false, action=replan when the arguments were wrong (unknown plant, missing id, access denied) or the result shows the plan needs different steps.
- action=finish only when the remaining steps are no longer needed because this result already settles the user's request.
Keep reason to one sentence.
