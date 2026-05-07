export type Language = "ISL" | "ASL";
export type VoiceGender = "Male" | "Female";

export interface GestureResult {
  categoryName: string;
  score: number;
}

export interface ConversationItem {
  id: string;
  text: string;
  timestamp: number;
  type?: "user" | "ai" | "system";
}

export interface SystemStatus {
  camera: "Active" | "Inactive" | "Error";
  model: "Loading" | "Ready" | "Error";
}
