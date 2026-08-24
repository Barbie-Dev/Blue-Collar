import type { Request, Response } from 'express'
import { catchAsync } from '../utils/catchAsync.js'
import * as searchService from '../services/search.service.js'

export type SearchService = Pick<typeof searchService, 'searchWorkers' | 'performAdvancedSearch'>

export function createSearchHandlers(service: SearchService = searchService) {
  return {
    searchWorkersHandler: catchAsync(async (req: Request, res: Response) => {
      const {
        q, query, lang, lat, lng, radius,
        categories, minRating, maxRating,
        dayOfWeek, isVerified, sortBy,
        page = '1', limit = '20',
      } = req.query

      const result = await service.searchWorkers({
        query: (q || query) ? String(q ?? query) : undefined,
        lang: lang ? String(lang) : undefined,
        lat: lat ? Number(lat) : undefined,
        lng: lng ? Number(lng) : undefined,
        radius: radius ? Number(radius) : undefined,
        categories: categories ? String(categories).split(',').map(c => c.trim()).filter(Boolean) : undefined,
        minRating: minRating ? Number(minRating) : undefined,
        maxRating: maxRating ? Number(maxRating) : undefined,
        dayOfWeek: dayOfWeek !== undefined ? Number(dayOfWeek) : undefined,
        isVerified: isVerified !== undefined ? isVerified === 'true' : undefined,
        sortBy: sortBy as any,
        page: Number(page),
        limit: Math.min(Math.max(Number(limit) || 20, 1), 100),
      }, req.ip)

      return res.json({ ...result, status: 'success', code: 200 })
    }),

    advancedSearch: catchAsync(async (req: Request, res: Response) => {
      const {
        query, lat, lng, radius, categories, minRating, maxRating,
        dayOfWeek, startTime, endTime, isVerified, sortBy,
        page = '1', limit = '20',
      } = req.query

      const result = await service.performAdvancedSearch({
        query: query ? String(query) : undefined,
        lat: lat ? Number(lat) : undefined,
        lng: lng ? Number(lng) : undefined,
        radius: radius ? Number(radius) : undefined,
        categories: categories ? String(categories).split(',').map(c => c.trim()).filter(Boolean) : undefined,
        minRating: minRating ? Number(minRating) : undefined,
        maxRating: maxRating ? Number(maxRating) : undefined,
        dayOfWeek: dayOfWeek ? Number(dayOfWeek) : undefined,
        startTime: startTime ? String(startTime) : undefined,
        endTime: endTime ? String(endTime) : undefined,
        isVerified: isVerified !== undefined ? isVerified === 'true' : undefined,
        sortBy: sortBy ? String(sortBy) : undefined,
        page: Number(page),
        limit: Number(limit),
      }, req.ip || 'unknown')

      return res.json({ ...result, status: 'success', code: 200 })
    }),
  }
}

export const { searchWorkersHandler, advancedSearch } = createSearchHandlers()
