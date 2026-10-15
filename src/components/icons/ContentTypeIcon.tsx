import recordIcon from "../../assets/icons/record-color.svg";
import aiChatIcon from "../../assets/icons/ai-chat-color.svg";
import voiceRecordIcon from "../../assets/icons/voice-record-color.svg";

interface ContentTypeIconProps {
  size?: number;
  className?: string;
  "aria-label"?: string;
}

function ContentTypeIcon({ src, size = 16, className, "aria-label": label }: ContentTypeIconProps & { src: string }) {
  return <img src={src} width={size} height={size} className={className} alt={label ?? ""}
    aria-hidden={label ? undefined : true}
    style={{ width: size, height: size, flexShrink: 0, display: "inline-block", verticalAlign: "middle" }} />;
}

/** Shared Record identity; parents provide the accessible name by default. */
export function RecordIcon({ isVoice = false, ...props }: ContentTypeIconProps & { isVoice?: boolean }) {
  return <ContentTypeIcon {...props} src={isVoice ? voiceRecordIcon : recordIcon} />;
}

export function VoiceRecordIcon(props: ContentTypeIconProps) {
  return <ContentTypeIcon {...props} src={voiceRecordIcon} />;
}

/** Shared AI conversation identity; fixed artwork also survives active and dark themes. */
export function AiChatIcon(props: ContentTypeIconProps) {
  return <ContentTypeIcon {...props} src={aiChatIcon} />;
}
