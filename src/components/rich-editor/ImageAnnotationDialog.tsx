import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Circle, MousePointer2, PencilLine, Square, Type, ZoomIn, RotateCcw } from "lucide-react";
import { Ellipse as KonvaEllipse, Group, Image as KonvaImage, Layer, Line, Rect, Stage, Text, Transformer } from "react-konva";

import { Button, IconButton } from "../../ui/components";
import { Dialog } from "../../ui/components/Dialog";
import {
  commitTextAnnotation,
  createEmptyImageAnnotationDocument,
  createImageAnnotationId,
  fitImageAnnotationViewport,
  imagePointFromViewportPoint,
  normalizeDraggedShape,
  parseImageAnnotationState,
  serializeImageAnnotationState,
  type ImageAnnotationDocument,
  type ImageAnnotationEllipseItem,
  type ImageAnnotationImageSize,
  type ImageAnnotationInkItem,
  type ImageAnnotationItem,
  type ImageAnnotationRectItem,
  type ImageAnnotationTextItem,
  type ImageAnnotationTool,
  type ImageAnnotationViewport,
  zoomViewportAtPoint,
} from "./image-annotations";

const INK_STROKE_WIDTH = 6;
const TEXT_DEFAULT_WIDTH = 240;
const MIN_SHAPE_SIZE = 8;
const ANNOTATION_STROKE = "#d44c47";
const ANNOTATION_FILL = "rgba(212, 76, 71, 0.12)";
const ANNOTATION_TEXT = "#9a3530";
const DIALOG_VIEWPORT_FALLBACK = { width: 960, height: 640 };

interface ImageAnnotationDialogProps {
  open: boolean;
  readOnly: boolean;
  title: string;
  imageSrc: string;
  initialAnnotationState?: string | null;
  imageSize?: Partial<ImageAnnotationImageSize> | null;
  onClose: () => void;
  onSave: (nextAnnotationState: string | null) => void;
}

interface PendingShape {
  id: string;
  type: "rect" | "ellipse";
  start: { x: number; y: number };
  current: { x: number; y: number };
}

interface TextEditorState {
  id: string;
  value: string;
}

interface DragPanState {
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

export function ImageAnnotationDialog({
  open,
  readOnly,
  title,
  imageSrc,
  initialAnnotationState,
  imageSize,
  onClose,
  onSave,
}: ImageAnnotationDialogProps) {
  const initialDocument = useMemo(
    () => parseImageAnnotationState(initialAnnotationState, imageSize),
    [imageSize, initialAnnotationState],
  );
  const [documentState, setDocumentState] = useState<ImageAnnotationDocument>(initialDocument);
  const [activeTool, setActiveTool] = useState<ImageAnnotationTool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ImageAnnotationViewport>(() =>
    fitImageAnnotationViewport(initialDocument.image, DIALOG_VIEWPORT_FALLBACK),
  );
  const [pendingInk, setPendingInk] = useState<ImageAnnotationInkItem | null>(null);
  const [pendingShape, setPendingShape] = useState<PendingShape | null>(null);
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);
  const [panState, setPanState] = useState<DragPanState | null>(null);
  const [imageElement, setImageElement] = useState<HTMLImageElement | null>(null);
  const [viewportSize, setViewportSize] = useState(DIALOG_VIEWPORT_FALLBACK);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const itemNodeRefs = useRef(new Map<string, Konva.Node>());
  const initialSerializedRef = useRef<string | null>(serializeImageAnnotationState(initialDocument));

  useEffect(() => {
    if (!open) {
      return;
    }

    const nextDocument = parseImageAnnotationState(initialAnnotationState, imageSize);

    setDocumentState(nextDocument);
    setActiveTool("select");
    setSelectedId(null);
    setPendingInk(null);
    setPendingShape(null);
    setTextEditor(null);
    setPanState(null);
    setImageElement(null);
    initialSerializedRef.current = serializeImageAnnotationState(nextDocument);
  }, [imageSize, initialAnnotationState, open]);

  useEffect(() => {
    if (!open || !imageSrc) {
      return;
    }

    const nextImage = new window.Image();

    nextImage.decoding = "async";
    nextImage.onload = () => {
      setImageElement(nextImage);
      setDocumentState((current) => {
        if (current.items.length > 0) {
          return current;
        }

        const naturalWidth = nextImage.naturalWidth || current.image.width;
        const naturalHeight = nextImage.naturalHeight || current.image.height;

        if (
          naturalWidth === current.image.width &&
          naturalHeight === current.image.height
        ) {
          return current;
        }

        return {
          ...current,
          image: {
            width: naturalWidth,
            height: naturalHeight,
          },
        };
      });
    };
    nextImage.src = imageSrc;
  }, [imageSrc, open]);

  useLayoutEffect(() => {
    if (!open || !containerRef.current) {
      return;
    }

    const measure = () => {
      const nextWidth = containerRef.current?.clientWidth || DIALOG_VIEWPORT_FALLBACK.width;
      const nextHeight = containerRef.current?.clientHeight || DIALOG_VIEWPORT_FALLBACK.height;

      setViewportSize({ width: nextWidth, height: nextHeight });
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(() => {
      measure();
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setViewport(fitImageAnnotationViewport(documentState.image, viewportSize));
  }, [documentState.image, open, viewportSize]);

  useEffect(() => {
    const transformer = transformerRef.current;

    if (!transformer) {
      return;
    }

    const selectedNode = selectedId ? itemNodeRefs.current.get(selectedId) : null;

    if (!selectedNode || readOnly) {
      transformer.nodes([]);
      transformer.getLayer()?.batchDraw();
      return;
    }

    const selectedItem = documentState.items.find((item) => item.id === selectedId);

    if (!selectedItem || selectedItem.type === "ink") {
      transformer.nodes([]);
      transformer.getLayer()?.batchDraw();
      return;
    }

    transformer.nodes([selectedNode]);
    transformer.getLayer()?.batchDraw();
  }, [documentState.items, readOnly, selectedId]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && textEditor) {
        event.preventDefault();
        setTextEditor(null);
        return;
      }

      if (
        !readOnly &&
        selectedId &&
        !textEditor &&
        (event.key === "Backspace" || event.key === "Delete")
      ) {
        event.preventDefault();
        setDocumentState((current) => ({
          ...current,
          items: current.items.filter((item) => item.id !== selectedId),
        }));
        setSelectedId(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, readOnly, selectedId, textEditor]);

  const dirty = useMemo(
    () => serializeImageAnnotationState(documentState) !== initialSerializedRef.current,
    [documentState],
  );

  const resetViewport = useCallback(() => {
    setViewport(fitImageAnnotationViewport(documentState.image, viewportSize));
  }, [documentState.image, viewportSize]);

  const handleRequestClose = useCallback(() => {
    if (textEditor) {
      setTextEditor(null);
      return;
    }

    if (dirty && !window.confirm("标注尚未保存，确认关闭图片浏览吗？")) {
      return;
    }

    onClose();
  }, [dirty, onClose, textEditor]);

  const handleSave = useCallback(() => {
    if (textEditor) {
      return;
    }

    onSave(serializeImageAnnotationState(documentState));
  }, [documentState, onSave, textEditor]);

  const updateItem = useCallback((itemId: string, updater: (item: ImageAnnotationItem) => ImageAnnotationItem) => {
    setDocumentState((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === itemId ? updater(item) : item)),
    }));
  }, []);

  const finishTextEdit = useCallback(
    (confirmed: boolean) => {
      if (!textEditor) {
        return;
      }

      const currentTextItem = documentState.items.find((item) => item.id === textEditor.id);

      if (!currentTextItem || currentTextItem.type !== "text") {
        setTextEditor(null);
        setSelectedId(null);
        return;
      }

      const nextText = confirmed
        ? commitTextAnnotation(currentTextItem, textEditor.value)
        : currentTextItem.text.trim()
          ? currentTextItem
          : null;

      setDocumentState((current) => {
        if (!nextText) {
          return {
            ...current,
            items: current.items.filter((item) => item.id !== textEditor.id),
          };
        }

        return {
          ...current,
          items: current.items.map((item) => (item.id === textEditor.id ? nextText : item)),
        };
      });
      setTextEditor(null);
      setSelectedId(nextText ? textEditor.id : null);
    },
    [documentState.items, textEditor],
  );

  const beginTextEdit = useCallback((item: ImageAnnotationTextItem) => {
    setSelectedId(item.id);
    setTextEditor({
      id: item.id,
      value: item.text,
    });
  }, []);

  const beginNewText = useCallback(
    (point: { x: number; y: number }) => {
      const textItem: ImageAnnotationTextItem = {
        id: createImageAnnotationId(),
        type: "text",
        rotation: 0,
        x: point.x,
        y: point.y,
        width: TEXT_DEFAULT_WIDTH,
        fontSize: 28,
        text: "",
      };

      setDocumentState((current) => ({
        ...current,
        items: [...current.items, textItem],
      }));
      beginTextEdit(textItem);
      setActiveTool("select");
    },
    [beginTextEdit],
  );

  const pointerToImage = useCallback(() => {
    const pointer = stageRef.current?.getPointerPosition();

    if (!pointer) {
      return null;
    }

    const nextPoint = imagePointFromViewportPoint(viewport, pointer);

    return {
      x: Math.max(0, Math.min(documentState.image.width, nextPoint.x)),
      y: Math.max(0, Math.min(documentState.image.height, nextPoint.y)),
    };
  }, [documentState.image.height, documentState.image.width, viewport]);

  const handleStageMouseDown = useCallback(
    (event: KonvaEventObject<MouseEvent>) => {
      if (textEditor) {
        finishTextEdit(true);
      }

      if (!isAnnotationSurfaceTarget(event.target)) {
        return;
      }

      if (activeTool === "select" || readOnly) {
        setSelectedId(null);
        setPanState({
          startX: event.evt.clientX,
          startY: event.evt.clientY,
          originX: viewport.x,
          originY: viewport.y,
        });
        return;
      }

      const point = pointerToImage();

      if (!point) {
        return;
      }

      if (activeTool === "ink") {
        setSelectedId(null);
        setPendingInk({
          id: createImageAnnotationId(),
          type: "ink",
          rotation: 0,
          points: [point.x, point.y],
          strokeWidth: INK_STROKE_WIDTH,
        });
        return;
      }

      if (activeTool === "rect" || activeTool === "ellipse") {
        setSelectedId(null);
        setPendingShape({
          id: createImageAnnotationId(),
          type: activeTool,
          start: point,
          current: point,
        });
        return;
      }
    },
    [activeTool, finishTextEdit, pointerToImage, readOnly, textEditor, viewport.x, viewport.y],
  );

  const handleStageMouseMove = useCallback(
    (event: KonvaEventObject<MouseEvent>) => {
      if (panState) {
        setViewport((current) => ({
          ...current,
          x: panState.originX + (event.evt.clientX - panState.startX),
          y: panState.originY + (event.evt.clientY - panState.startY),
        }));
        return;
      }

      const point = pointerToImage();

      if (!point) {
        return;
      }

      if (pendingInk) {
        setPendingInk((current) =>
          current
            ? {
                ...current,
                points: [...current.points, point.x, point.y],
              }
            : current,
        );
        return;
      }

      if (pendingShape) {
        setPendingShape((current) =>
          current
            ? {
                ...current,
                current: point,
              }
            : current,
        );
      }
    },
    [panState, pendingInk, pendingShape, pointerToImage],
  );

  const handleStageMouseUp = useCallback(() => {
    if (panState) {
      setPanState(null);
    }

    if (pendingInk) {
      if (pendingInk.points.length >= 4) {
        setDocumentState((current) => ({
          ...current,
          items: [...current.items, pendingInk],
        }));
        setSelectedId(pendingInk.id);
      }

      setPendingInk(null);
      return;
    }

    if (pendingShape) {
      const bounds = normalizeDraggedShape(pendingShape.start, pendingShape.current);

      if (bounds.width >= MIN_SHAPE_SIZE && bounds.height >= MIN_SHAPE_SIZE) {
        const nextItem: ImageAnnotationRectItem | ImageAnnotationEllipseItem =
          pendingShape.type === "rect"
            ? {
                id: pendingShape.id,
                type: "rect",
                rotation: 0,
                ...bounds,
              }
            : {
                id: pendingShape.id,
                type: "ellipse",
                rotation: 0,
                ...bounds,
              };

        setDocumentState((current) => ({
          ...current,
          items: [...current.items, nextItem],
        }));
        setSelectedId(nextItem.id);
      }

      setPendingShape(null);
    }
  }, [panState, pendingInk, pendingShape]);

  const handleStageClick = useCallback(
    (event: KonvaEventObject<MouseEvent>) => {
      if (readOnly || activeTool !== "text") {
        return;
      }

      if (!isAnnotationSurfaceTarget(event.target)) {
        return;
      }

      const point = pointerToImage();

      if (!point) {
        return;
      }

      beginNewText(point);
    },
    [activeTool, beginNewText, pointerToImage, readOnly],
  );

  const handleWheel = useCallback(
    (event: KonvaEventObject<WheelEvent>) => {
      event.evt.preventDefault();
      const pointer = stageRef.current?.getPointerPosition();

      if (!pointer) {
        return;
      }

      const direction = event.evt.deltaY > 0 ? -1 : 1;
      const scaleBy = event.evt.ctrlKey || event.evt.metaKey ? 1.14 : 1.08;
      const nextScale = viewport.scale * (direction > 0 ? scaleBy : 1 / scaleBy);

      setViewport(zoomViewportAtPoint({ viewport, nextScale, pointer }));
    },
    [viewport],
  );

  const currentEditingItem = useMemo(() => {
    if (!textEditor) {
      return null;
    }

    const item = documentState.items.find((candidate) => candidate.id === textEditor.id);

    return item?.type === "text" ? item : null;
  }, [documentState.items, textEditor]);
  const textareaStyle = useMemo(() => {
    if (!currentEditingItem || !containerRef.current) {
      return null;
    }

    return {
      left: viewport.x + currentEditingItem.x * viewport.scale,
      top: viewport.y + currentEditingItem.y * viewport.scale,
      width: currentEditingItem.width * viewport.scale,
      minHeight: currentEditingItem.fontSize * viewport.scale * 2.2,
      fontSize: currentEditingItem.fontSize * viewport.scale,
      lineHeight: 1.35,
    };
  }, [currentEditingItem, viewport.scale, viewport.x, viewport.y]);

  const renderItem = useCallback(
    (item: ImageAnnotationItem) => {
      const commonShapeProps = {
        key: item.id,
        ref: (node: Konva.Node | null) => {
          if (node) {
            itemNodeRefs.current.set(item.id, node);
            return;
          }

          itemNodeRefs.current.delete(item.id);
        },
        onClick: () => {
          setSelectedId(item.id);
          setActiveTool("select");
        },
        draggable: !readOnly && activeTool === "select" && !textEditor,
        onDragEnd: (event: KonvaEventObject<DragEvent>) => {
          if (item.type === "ink") {
            const { x: deltaX, y: deltaY } = event.target.position();

            updateItem(item.id, (current) =>
              current.type === "ink"
                ? {
                    ...current,
                    points: current.points.map((point, index) =>
                      index % 2 === 0 ? point + deltaX : point + deltaY,
                    ),
                  }
                : current,
            );
            event.target.position({ x: 0, y: 0 });
            return;
          }

          const { x, y } = event.target.position();

          updateItem(item.id, (current) =>
            current.type === "text" || current.type === "rect" || current.type === "ellipse"
              ? {
                  ...current,
                  x,
                  y,
                }
              : current,
          );
        },
      } satisfies Record<string, unknown>;

      if (item.type === "ink") {
        return (
          <Line
            {...commonShapeProps}
            points={item.points}
            stroke={ANNOTATION_STROKE}
            strokeWidth={item.strokeWidth}
            lineCap="round"
            lineJoin="round"
            tension={0}
          />
        );
      }

      if (item.type === "rect") {
        return (
          <Rect
            {...commonShapeProps}
            x={item.x}
            y={item.y}
            width={item.width}
            height={item.height}
            rotation={item.rotation}
            cornerRadius={10}
            stroke={ANNOTATION_STROKE}
            strokeWidth={4}
            fill={ANNOTATION_FILL}
            onTransformEnd={(event) => {
              const node = event.target as Konva.Rect;
              const nextWidth = Math.max(MIN_SHAPE_SIZE, node.width() * node.scaleX());
              const nextHeight = Math.max(MIN_SHAPE_SIZE, node.height() * node.scaleY());

              updateItem(item.id, (current) =>
                current.type === "rect"
                  ? {
                      ...current,
                      x: node.x(),
                      y: node.y(),
                      width: nextWidth,
                      height: nextHeight,
                      rotation: node.rotation(),
                    }
                  : current,
              );

              node.scaleX(1);
              node.scaleY(1);
            }}
          />
        );
      }

      if (item.type === "ellipse") {
        return (
          <KonvaEllipse
            {...commonShapeProps}
            x={item.x + item.width / 2}
            y={item.y + item.height / 2}
            radiusX={item.width / 2}
            radiusY={item.height / 2}
            rotation={item.rotation}
            stroke={ANNOTATION_STROKE}
            strokeWidth={4}
            fill={ANNOTATION_FILL}
            offsetX={0}
            offsetY={0}
            onDragEnd={(event) => {
              const node = event.target as Konva.Ellipse;
              updateItem(item.id, (current) =>
                current.type === "ellipse"
                  ? {
                      ...current,
                      x: node.x() - current.width / 2,
                      y: node.y() - current.height / 2,
                    }
                  : current,
              );
            }}
            onTransformEnd={(event) => {
              const node = event.target as Konva.Ellipse;
              const nextWidth = Math.max(MIN_SHAPE_SIZE, node.radiusX() * 2 * node.scaleX());
              const nextHeight = Math.max(MIN_SHAPE_SIZE, node.radiusY() * 2 * node.scaleY());

              updateItem(item.id, (current) =>
                current.type === "ellipse"
                  ? {
                      ...current,
                      x: node.x() - nextWidth / 2,
                      y: node.y() - nextHeight / 2,
                      width: nextWidth,
                      height: nextHeight,
                      rotation: node.rotation(),
                    }
                  : current,
              );

              node.scaleX(1);
              node.scaleY(1);
            }}
          />
        );
      }

      return (
        <Text
          {...commonShapeProps}
          x={item.x}
          y={item.y}
          width={item.width}
          fontSize={item.fontSize}
          rotation={item.rotation}
          fontFamily="Work Sans, PingFang SC, sans-serif"
          fontStyle="bold"
          fill={ANNOTATION_TEXT}
          text={item.text}
          padding={4}
          wrap="word"
          onDblClick={() => {
            if (!readOnly) {
              beginTextEdit(item);
            }
          }}
          onTransformEnd={(event) => {
            const node = event.target as Konva.Text;
            const nextWidth = Math.max(80, node.width() * node.scaleX());
            const nextFontSize = Math.max(12, item.fontSize * node.scaleY());

            updateItem(item.id, (current) =>
              current.type === "text"
                ? {
                    ...current,
                    x: node.x(),
                    y: node.y(),
                    width: nextWidth,
                    fontSize: nextFontSize,
                    rotation: node.rotation(),
                  }
                : current,
            );

            node.scaleX(1);
            node.scaleY(1);
          }}
        />
      );
    },
    [activeTool, beginTextEdit, readOnly, textEditor, updateItem],
  );

  const previewShape = useMemo(() => {
    if (!pendingShape) {
      return null;
    }

    const bounds = normalizeDraggedShape(pendingShape.start, pendingShape.current);

    if (pendingShape.type === "rect") {
      return (
        <Rect
          x={bounds.x}
          y={bounds.y}
          width={bounds.width}
          height={bounds.height}
          cornerRadius={10}
          stroke={ANNOTATION_STROKE}
          strokeWidth={4}
          fill={ANNOTATION_FILL}
          dash={[10, 8]}
        />
      );
    }

    return (
      <KonvaEllipse
        x={bounds.x + bounds.width / 2}
        y={bounds.y + bounds.height / 2}
        radiusX={bounds.width / 2}
        radiusY={bounds.height / 2}
        stroke={ANNOTATION_STROKE}
        strokeWidth={4}
        fill={ANNOTATION_FILL}
        dash={[10, 8]}
      />
    );
  }, [pendingShape]);

  return (
    <Dialog
      open={open}
      title={title}
      description={readOnly ? "浏览图片并查看标注" : "浏览图片并补充图片标注"}
      onClose={handleRequestClose}
      widthClassName="max-w-[min(96rem,100%)]"
      bodyClassName="px-0 py-0"
      footer={
        <>
          <Button variant="ghost" onClick={handleRequestClose}>
            关闭
          </Button>
          {!readOnly ? (
            <Button variant="primary" onClick={handleSave} disabled={Boolean(textEditor)}>
              保存标注
            </Button>
          ) : null}
        </>
      }
    >
      <div className="image-annotation-dialog">
        <div className="image-annotation-dialog__toolbar">
          <div className="image-annotation-dialog__tool-group" role="group" aria-label="标注工具">
            <ToolButton
              active={activeTool === "select"}
              disabled={false}
              icon={<MousePointer2 size={15} />}
              label="浏览"
              onClick={() => setActiveTool("select")}
            />
            <ToolButton
              active={activeTool === "ink"}
              disabled={readOnly}
              icon={<PencilLine size={15} />}
              label="墨迹"
              onClick={() => setActiveTool("ink")}
            />
            <ToolButton
              active={activeTool === "rect"}
              disabled={readOnly}
              icon={<Square size={15} />}
              label="矩形"
              onClick={() => setActiveTool("rect")}
            />
            <ToolButton
              active={activeTool === "ellipse"}
              disabled={readOnly}
              icon={<Circle size={15} />}
              label="圆形"
              onClick={() => setActiveTool("ellipse")}
            />
            <ToolButton
              active={activeTool === "text"}
              disabled={readOnly}
              icon={<Type size={15} />}
              label="文字"
              onClick={() => setActiveTool("text")}
            />
          </div>

          <div className="image-annotation-dialog__tool-group" role="group" aria-label="视图操作">
            <Button variant="ghost" size="sm" onClick={resetViewport}>
              适应窗口
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setViewport({
                  scale: 1,
                  x: Math.max(0, (viewportSize.width - documentState.image.width) / 2),
                  y: Math.max(0, (viewportSize.height - documentState.image.height) / 2),
                });
              }}
            >
              100%
            </Button>
            <IconButton
              aria-label="重置视图"
              title="重置视图"
              variant="ghost"
              size="sm"
              onClick={resetViewport}
            >
              <RotateCcw size={14} />
            </IconButton>
            <div className="image-annotation-dialog__zoom-chip">
              <ZoomIn size={13} />
              <span>{Math.round(viewport.scale * 100)}%</span>
            </div>
          </div>
        </div>

        <div
          ref={containerRef}
          className={[
            "image-annotation-dialog__canvas",
            panState ? "is-panning" : "",
            activeTool === "ink" ? "is-drawing" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          data-testid="image-annotation-canvas"
        >
          <Stage
            ref={stageRef}
            width={viewportSize.width}
            height={viewportSize.height}
            onMouseDown={handleStageMouseDown}
            onMouseMove={handleStageMouseMove}
            onMouseUp={handleStageMouseUp}
            onClick={handleStageClick}
            onWheel={handleWheel}
          >
            <Layer>
              <Rect
                x={0}
                y={0}
                width={viewportSize.width}
                height={viewportSize.height}
                fill="#f5f3ef"
                name="annotation-surface"
              />
              <Group x={viewport.x} y={viewport.y} scaleX={viewport.scale} scaleY={viewport.scale}>
                <Rect
                  x={0}
                  y={0}
                  width={documentState.image.width}
                  height={documentState.image.height}
                  fill="#fbfaf7"
                  cornerRadius={12}
                  shadowBlur={0}
                  name="annotation-surface"
                />
                {imageElement ? (
                  <KonvaImage
                    image={imageElement}
                    width={documentState.image.width}
                    height={documentState.image.height}
                    name="annotation-surface"
                  />
                ) : null}
                {documentState.items.map((item) => renderItem(item))}
                {pendingInk ? (
                  <Line
                    points={pendingInk.points}
                    stroke={ANNOTATION_STROKE}
                    strokeWidth={pendingInk.strokeWidth}
                    lineCap="round"
                    lineJoin="round"
                  />
                ) : null}
                {previewShape}
                <Transformer
                  ref={transformerRef}
                  rotateEnabled={!readOnly}
                  enabledAnchors={
                    readOnly
                      ? []
                      : ["top-left", "top-right", "bottom-left", "bottom-right", "middle-left", "middle-right"]
                  }
                  borderStroke={ANNOTATION_STROKE}
                  anchorStroke={ANNOTATION_STROKE}
                  anchorFill="#ffffff"
                  anchorCornerRadius={999}
                  boundBoxFunc={(_oldBox, nextBox) =>
                    nextBox.width < MIN_SHAPE_SIZE || nextBox.height < MIN_SHAPE_SIZE
                      ? _oldBox
                      : nextBox
                  }
                />
              </Group>
            </Layer>
          </Stage>

          {textareaStyle && textEditor ? (
            <textarea
              autoFocus
              data-testid="image-annotation-text-editor"
              className="image-annotation-dialog__textarea"
              placeholder="输入图片标注"
              style={textareaStyle}
              value={textEditor.value}
              onChange={(event) =>
                setTextEditor((current) =>
                  current
                    ? {
                        ...current,
                        value: event.target.value,
                      }
                    : current,
                )
              }
              onBlur={() => finishTextEdit(true)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  finishTextEdit(true);
                  return;
                }

                if (event.key === "Escape") {
                  event.preventDefault();
                  finishTextEdit(false);
                }
              }}
            />
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

function ToolButton({
  active,
  disabled,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      disabled={disabled}
      className={active ? "image-annotation-dialog__tool-button is-active" : "image-annotation-dialog__tool-button"}
      leadingIcon={icon}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

function isAnnotationSurfaceTarget(target: Konva.Node | null) {
  return Boolean(
    target &&
      (target === target.getStage() || target.hasName("annotation-surface")),
  );
}
