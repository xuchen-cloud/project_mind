import { FileTypeIcon as UpstreamFileTypeIcon, classifyFileType, type FileTypeIconProps } from "../upstream/client/ui-primitives/src/FileTypeIcon";
import { FileIcon } from "../../../src/components/document/FileIcon";

export * from "../upstream/client/ui-primitives/src/index";

/** Keep upstream mapped artwork/context; host unknown filenames use system type icons. */
export function FileTypeIcon(props: FileTypeIconProps) {
  if ("path" in props && classifyFileType(props.path, props.context) === "other") {
    const name = props.path.slice(Math.max(props.path.lastIndexOf("/"), props.path.lastIndexOf("\\")) + 1);
    return <FileIcon name={name} size={props.size ?? 28} className={props.className} />;
  }
  return <UpstreamFileTypeIcon {...props} />;
}
