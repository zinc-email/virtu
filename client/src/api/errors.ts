// Extract the SimpleLogin {"error": "..."} envelope from an axios error.
// The API's error strings are written to be user-presentable.

export function apiErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "response" in err) {
    const response = err.response;
    if (response && typeof response === "object" && "data" in response) {
      const data = response.data;
      if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
        return data.error;
      }
    }
  }
  return "Something went wrong";
}
