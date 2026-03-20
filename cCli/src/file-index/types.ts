// src/file-index/types.ts

/** 模糊搜索结果 */
export interface SearchResult {
  /** 相对路径（正斜杠分隔） */
  path: string
  /** 匹配分数，越高越好 */
  score: number
  /** 匹配字符位置集合 */
  positions: Set<number>
}

/** 目录浏览条目（文件或子目录） */
export interface DirEntry {
  /** 显示名（文件夹含末尾 "/"） */
  name: string
  /** 完整相对路径 */
  fullPath: string
  /** 是否为目录 */
  isDir: boolean
}
