import { describe, it, expect, beforeEach } from 'vitest'
import { BM25Index } from '@memory/rag/bm25.js'
import { JiebaTokenizer, BigramTokenizer } from '@memory/rag/tokenizer.js'

describe('BM25Index', () => {
  describe('with JiebaTokenizer', () => {
    let index: BM25Index

    beforeEach(() => {
      index = new BM25Index(new JiebaTokenizer())
    })

    it('空索引搜索返回空', () => {
      expect(index.search('测试', { topK: 5 })).toEqual([])
    })

    it('基础中文检索', () => {
      index.add({ chunkId: 'c1', entryId: 'e1', text: '认证中间件需要重写以满足合规要求', scope: 'project', tags: ['auth'], type: 'project' })
      index.add({ chunkId: 'c2', entryId: 'e2', text: '前端组件需要使用React函数组件', scope: 'project', tags: ['frontend'], type: 'project' })
      index.add({ chunkId: 'c3', entryId: 'e3', text: '数据库索引优化提升查询性能', scope: 'project', tags: ['db'], type: 'project' })

      const results = index.search('认证中间件', { topK: 3 })
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.entryId).toBe('e1')
    })

    it('英文检索', () => {
      index.add({ chunkId: 'c1', entryId: 'e1', text: 'React component design patterns', scope: 'global', tags: [], type: 'user' })
      index.add({ chunkId: 'c2', entryId: 'e2', text: 'Database query optimization', scope: 'global', tags: [], type: 'user' })

      const results = index.search('React component', { topK: 2 })
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.entryId).toBe('e1')
    })

    it('scope 过滤下推', () => {
      index.add({ chunkId: 'c1', entryId: 'e1', text: '全局用户偏好设置', scope: 'global', tags: [], type: 'user' })
      index.add({ chunkId: 'c2', entryId: 'e2', text: '项目用户偏好配置', scope: 'project', tags: [], type: 'user' })

      const results = index.search('用户偏好', { topK: 5, scope: 'global' })
      expect(results.every(r => {
        // 验证确实只返回了 global scope 的结果
        return r.entryId === 'e1'
      })).toBe(true)
    })

    it('tags 过滤下推', () => {
      index.add({ chunkId: 'c1', entryId: 'e1', text: '认证模块需要优化', scope: 'project', tags: ['auth', 'security'], type: 'project' })
      index.add({ chunkId: 'c2', entryId: 'e2', text: '认证流程文档更新', scope: 'project', tags: ['docs'], type: 'project' })

      const results = index.search('认证', { topK: 5, tags: ['auth'] })
      expect(results).toHaveLength(1)
      expect(results[0]!.entryId).toBe('e1')
    })

    it('type 过滤下推', () => {
      index.add({ chunkId: 'c1', entryId: 'e1', text: '代码风格使用函数式', scope: 'global', tags: [], type: 'feedback' })
      index.add({ chunkId: 'c2', entryId: 'e2', text: '代码风格偏好记录', scope: 'global', tags: [], type: 'user' })

      const results = index.search('代码风格', { topK: 5, type: 'feedback' })
      expect(results).toHaveLength(1)
      expect(results[0]!.entryId).toBe('e1')
    })

    it('remove 删除文档后搜不到', () => {
      index.add({ chunkId: 'c1', entryId: 'e1', text: '待删除的记忆内容', scope: 'project', tags: [], type: 'project' })
      expect(index.search('删除', { topK: 5 }).length).toBeGreaterThan(0)

      index.remove('c1')
      expect(index.search('删除', { topK: 5 })).toEqual([])
      expect(index.size).toBe(0)
    })

    it('removeByEntryId 删除指定 entry 的所有 chunk', () => {
      index.add({ chunkId: 'e1_0', entryId: 'e1', text: '认证模块第一部分', scope: 'project', tags: [], type: 'project' })
      index.add({ chunkId: 'e1_1', entryId: 'e1', text: '认证模块第二部分', scope: 'project', tags: [], type: 'project' })
      index.add({ chunkId: 'e2_0', entryId: 'e2', text: '其他内容', scope: 'project', tags: [], type: 'project' })
      expect(index.size).toBe(3)

      index.removeByEntryId('e1')
      expect(index.size).toBe(1)
    })

    it('clear 清空索引', () => {
      index.add({ chunkId: 'c1', entryId: 'e1', text: '内容', scope: 'project', tags: [], type: 'project' })
      index.clear()
      expect(index.size).toBe(0)
    })

    it('IDF 权重：稀有词排名更高', () => {
      // "量子计算" 只出现在 e1 中，"优化" 在 e1 和 e2 中都出现
      index.add({ chunkId: 'c1', entryId: 'e1', text: '量子计算性能优化研究', scope: 'project', tags: [], type: 'project' })
      index.add({ chunkId: 'c2', entryId: 'e2', text: '数据库查询优化方案', scope: 'project', tags: [], type: 'project' })
      index.add({ chunkId: 'c3', entryId: 'e3', text: '网络通信协议分析', scope: 'project', tags: [], type: 'project' })

      const results = index.search('量子计算', { topK: 3 })
      expect(results[0]!.entryId).toBe('e1')
    })
  })

  describe('with BigramTokenizer', () => {
    it('降级分词器也能正常工作', () => {
      const index = new BM25Index(new BigramTokenizer())
      index.add({ chunkId: 'c1', entryId: 'e1', text: '认证中间件重写', scope: 'project', tags: [], type: 'project' })
      const results = index.search('中间件', { topK: 5 })
      expect(results.length).toBeGreaterThan(0)
    })
  })
})
