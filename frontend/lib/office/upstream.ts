const defaultOfficeUrl = "http://127.0.0.1:8001";

export function officeEndpoint(path: "events" | "tasks") {
  return new URL(`/api/office/${path}`, process.env.FLOW_OFFICE_API_URL || defaultOfficeUrl);
}
