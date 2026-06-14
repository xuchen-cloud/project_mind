const DEFAULT_PROJECT_NAME = "未命名项目";

export function generateDefaultProjectName(existingNames: string[]) {
  const normalizedNames = new Set(existingNames.map((name) => name.trim()).filter(Boolean));

  if (!normalizedNames.has(DEFAULT_PROJECT_NAME)) {
    return DEFAULT_PROJECT_NAME;
  }

  let suffix = 2;
  while (normalizedNames.has(`${DEFAULT_PROJECT_NAME} ${suffix}`)) {
    suffix += 1;
  }

  return `${DEFAULT_PROJECT_NAME} ${suffix}`;
}
