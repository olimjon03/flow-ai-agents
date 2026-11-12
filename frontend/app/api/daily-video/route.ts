import { forwardDailyVideo } from "../../../lib/daily-video-proxy.ts";

export async function GET(request: Request) {
  return forwardDailyVideo(request);
}
export async function POST(request: Request) {
  return forwardDailyVideo(request);
}
