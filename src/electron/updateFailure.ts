export const OFFICIAL_RELEASES_URL = "https://github.com/zwatx/bordeaux/releases";

export function describeUpdateFailure(message: string): string {
  // Response bodies can contain entire proxy error pages. Use only the error
  // prefix for classification and keep the original message for Copy details.
  const diagnostic = message.split(/<!doctype\b|<html\b|<body\b/i, 1)[0];
  const signatureFailure = /signature|code requirement|codesign/i.test(diagnostic);
  const accessDenied = /\b403\b|\bforbidden\b/i.test(diagnostic);
  const networkFailure = /network|ENOTFOUND|ECONN|ETIMEDOUT|internet|timed? out/i.test(diagnostic);
  return signatureFailure
    ? "The downloaded update could not be verified. Save your work, then download an installer from the official Bordeaux releases page and replace the installed app manually."
    : accessDenied
      ? "The update request was denied (HTTP 403). GitHub or a network filter may be blocking the connection. Try again later or on another network, or open the official Bordeaux releases page to download an installer."
      : networkFailure
        ? "Check your internet connection and try Check for Updates again. You can also download an installer from the official Bordeaux releases page."
        : "Try Check for Updates again, or download an installer from the official Bordeaux releases page.";
}
