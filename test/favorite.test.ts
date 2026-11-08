import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../src/main/db/index'
import { createFavoriteService } from '../src/main/services/favorite'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithoard-fav-test-'))
let db: ReturnType<typeof openDatabase>
beforeAll(() => {
  db = openDatabase(dir)
})
afterAll(() => {
  closeDatabase()
})
beforeEach(() => {
  db.prepare('DELETE FROM favorites').run()
  // 收藏有外键约束，测试素材必须先存在；显式 id 便于用例直接引用
  const insert = db.prepare(
    `INSERT OR IGNORE INTO assets (id, source_id, remote_id, type, title, license, fetched_at)
     VALUES (?, 'pixabay', ?, 'image', ?, 'free', ?)`
  )
  for (let id = 1; id <= 20; id += 1) {
    insert.run(id, `test-${id}`, `test ${id}`, Date.now())
  }
})

describe('收藏夹 service', () => {
  const service = createFavoriteService()

  it('toggle：未收藏时收藏，再次 toggle 时取消', async () => {
    const first = await service.toggle({ assetId: 1 })
    expect(first).toEqual({ ok: true, favorited: true })
    const second = await service.toggle({ assetId: 1 })
    expect(second).toEqual({ ok: true, favorited: false })
  })

  it('toggle：非法 assetId 拒绝', async () => {
    for (const bad of [{ assetId: 0 }, { assetId: -1 }, { assetId: 1.5 }, { assetId: '1' }, {}]) {
      await expect(service.toggle(bad)).rejects.toThrow()
    }
  })

  it('add：去重，已收藏的不重复计入', async () => {
    await service.toggle({ assetId: 2 })
    const result = await service.add({ ids: [2, 2, 3] })
    expect(result).toEqual({ ok: true, added: 1 })
  })

  it('add：非法 ids 拒绝', async () => {
    for (const bad of [
      { ids: [] },
      { ids: Array.from({ length: 201 }, (_, i) => i + 1) },
      { ids: [1.5] },
      { ids: ['1'] },
      { ids: [0] },
      {}
    ]) {
      await expect(service.add(bad)).rejects.toThrow()
    }
  })

  it('remove：移除存在的，忽略不存在的', async () => {
    await service.toggle({ assetId: 4 })
    const result = await service.remove({ ids: [4, 5] })
    expect(result).toEqual({ ok: true, removed: 1 })
    const after = await service.remove({ ids: [4] })
    expect(after).toEqual({ ok: true, removed: 0 })
  })

  it('remove：非法 ids 拒绝', async () => {
    for (const bad of [{ ids: [] }, { ids: [0] }, { ids: [1.5] }]) {
      await expect(service.remove(bad)).rejects.toThrow()
    }
  })

  it('list：默认分页与类型/关键词筛选', async () => {
    await service.toggle({ assetId: 10 })
    await service.toggle({ assetId: 11 })
    const page = service.list({ page: 1, pageSize: 5 })
    expect(page.total).toBeGreaterThanOrEqual(2)
    expect(page.page).toBe(1)
    expect(page.pageSize).toBe(5)
    expect(page.items.length).toBeLessThanOrEqual(5)

    expect(() => service.list({ page: 0 })).toThrow()
    expect(() => service.list({ type: 'gif' })).toThrow()
    expect(() => service.list({ keyword: 'a'.repeat(101) })).toThrow()
  })
})
