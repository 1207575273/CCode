import { describe, it, expect } from 'vitest'
import { ResumeCommand } from '@commands/resume.js'

describe('ResumeCommand', () => {
  it('should return show_resume_panel action', () => {
    const cmd = new ResumeCommand()
    const result = cmd.execute([])
    expect(result.handled).toBe(true)
    expect(result.action).toEqual({ type: 'show_resume_panel' })
  })

  it('should have name "resume"', () => {
    const cmd = new ResumeCommand()
    expect(cmd.name).toBe('resume')
  })
})
