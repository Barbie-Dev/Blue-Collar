import { categoryRepository } from '../repositories/category.repository.js'
import { AppError } from './AppError.js'

/**
 * Return all categories ordered by name.
 */
export async function listCategories() {
  return categoryRepository.findAll()
}

/**
 * Get a single category by id.
 * @throws AppError 404 if not found.
 */
export async function getCategory(id: string) {
  const category = await categoryRepository.findById(id)
  if (!category) throw new AppError('Not found', 404)
  return category
}

/**
 * Create a new category (admin only).
 * @throws AppError 409 if a category with that name already exists.
 */
export async function createCategory(data: { name: string; icon?: string; description?: string }) {
  const existing = await categoryRepository.findByName(data.name)
  if (existing) throw new AppError('Category already exists', 409)
  return categoryRepository.create(data)
}

/**
 * Update an existing category by id (admin only).
 * @throws AppError 404 if not found.
 */
export async function updateCategory(id: string, data: { name?: string; icon?: string; description?: string }) {
  const category = await categoryRepository.findById(id)
  if (!category) throw new AppError('Category not found', 404)
  return categoryRepository.update(id, data)
}

/**
 * Delete a category by id (admin only).
 * @throws AppError 404 if not found.
 */
export async function deleteCategory(id: string) {
  const category = await categoryRepository.findById(id)
  if (!category) throw new AppError('Category not found', 404)
  return categoryRepository.delete(id)
}
