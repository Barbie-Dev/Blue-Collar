/**
 * Lightweight dependency injection container for BlueCollar API.
 *
 * Re-exports the service factory types and provides convenience re-exports.
 * Each service module exposes its own `createXxxService(deps)` factory.
 *
 * ## Pattern summary
 *
 * Every service module exports:
 *   1. A `createXxxService(deps)` factory that returns a bound service object.
 *   2. Module-level function exports that delegate to a default instance wired
 *      with real production dependencies — this keeps all existing controller
 *      imports working unchanged.
 *
 * ## Usage in tests (DI — no vi.mock needed)
 * ```ts
 * import { createCategoryService } from '../services/category.service.js'
 *
 * const mockRepo = {
 *   findAll: vi.fn().mockResolvedValue([]),
 *   findById: vi.fn(),
 *   findByName: vi.fn(),
 *   create: vi.fn(),
 *   update: vi.fn(),
 *   delete: vi.fn(),
 *   count: vi.fn(),
 * }
 * const svc = createCategoryService({ categoryRepository: mockRepo })
 * const result = await svc.listCategories()
 * expect(mockRepo.findAll).toHaveBeenCalledOnce()
 * ```
 *
 * See docs/DI_PATTERN.md for the full guide and examples for every service.
 */

export type {
  CategoryServiceDeps,
  UserServiceDeps,
  AuthServiceDeps,
  IMailer,
  IDbClient,
} from './types.js'

export { createCategoryService } from '../services/category.service.js'
export { createUserService } from '../services/user.service.js'
export { createAuthService } from '../services/auth.service.js'
