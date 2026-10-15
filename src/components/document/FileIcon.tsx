import { classifyFileType, fileExtension, FileTypeIcon } from "@project-mind/dsh-ui/file-icons";
import { useQuery } from "@tanstack/react-query";
import { nativeFileIconApi } from "../../services/nativeFileIconApi";
import "@project-mind/dsh-ui/file-icons/styles.css";
import "./file-icon.css";

export interface FileIconProps {
  name: string;
  size?: number;
  className?: string;
}

function NativeTypeIcon({ name, size }: { name: string; size: number }) {
  const icon = useQuery({
    queryKey: ["native-file-type-icon", fileExtension(name).toLowerCase()],
    queryFn: () => nativeFileIconApi.typeIcon(name),
    // Share by type; the root QueryClient collects inactive entries after 10 minutes.
    staleTime: Infinity,
    retry: false,
  });
  if (icon.data) return <img src={icon.data} alt="" width={size} height={size} />;
  const title = icon.isError ? "无法加载系统文件类型图标"
    : icon.isPending ? "正在加载系统文件类型图标" : "系统未提供文件类型图标";
  return (
    <span className="file-icon-placeholder" title={title}>
      <FileTypeIcon kind="other" size={size} />
    </span>
  );
}

/** Decorative File presentation under the root QueryClient; the parent owns its accessible name. */
export function FileIcon({ name, size = 16, className }: FileIconProps) {
  return (
    <span className={["file-icon", className].filter(Boolean).join(" ")} style={{ width: size, height: size }} aria-hidden="true">
      {classifyFileType(name) === "other"
        ? <NativeTypeIcon name={name} size={size} />
        : <FileTypeIcon path={name} size={size} />}
    </span>
  );
}
