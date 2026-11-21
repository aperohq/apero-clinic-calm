// Test-only renderer for the constant JSON-schema fields sent by Retell.
export function renderBookingRequest(tool, variables) {
  function render(schema) {
    if (Object.hasOwn(schema, "const"))
      return typeof schema.const === "string"
        ? schema.const.replace(/{{([^}]+)}}/g, (_, key) => variables[key] ?? "")
        : schema.const;
    if (schema.type === "object")
      return Object.fromEntries(
        Object.entries(schema.properties).map(([key, field]) => [key, render(field)]),
      );
    throw Error("Booking field must be constant, never inferred state");
  }
  const args = render(tool.parameters);
  return tool.args_at_root ? args : { name: tool.name, call: variables.full_call, args };
}
