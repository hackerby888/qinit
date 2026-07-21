# Coding Rules for Qinit

- Keep behavior unchanged unless explicitly requested.
- Keep comments short and useful (1–2 lines, no noise).
- Prefer readable multiline code over dense one-line expressions (sometimes one-line is better if the code is still readable and simple, split it to multi-lines may even make it worse)
- Use clear variable and function names where readability improves clarity.
- Keep code style consistent with existing project formatting.
- Avoid compact blocks; favor explicit line breaks and spacing.
- Keep tests passing after edits; run the relevant suite before finishing a task.
- Preserve public API and behavior compatibility.
- Use short commit messages.
- Do not mention AI/LLM tools in commit messages.
- When spawning qubic core binary or test, run it in the tmp folder instead of current working folder (it will create many trash files in our project)