import { AppError } from "../core/errors.js";
/** Keep large file/attachment data once in the packet, with room for Tunnel framing. */
export function toolResult(value: unknown) {
  const json = JSON.parse(JSON.stringify(value));
  const serialized = JSON.stringify(json);
  const result = {
    content: [
      {
        type: "text" as const,
        text:
          Buffer.byteLength(serialized) > 1024 * 1024
            ? "Large result is available in structuredContent."
            : serialized,
      },
    ],
    structuredContent: json,
    isError: false,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
    throw new AppError(
      "CONTENT_TOO_LARGE",
      "Serialized tool result exceeds 8 MiB.",
      "Choose a smaller file, narrower query or smaller page.",
    );
  return result;
}
