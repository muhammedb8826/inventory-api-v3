import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { RequirePermissions } from './decorators/permissions.decorator';
import { PaginationQueryDto } from './dto/pagination.dto';
import { actionLabel } from './record-activity';

@Controller('audit-events')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AuditController {
  constructor(@InjectDataSource() private readonly db: DataSource) {}
  @Get()
  @RequirePermissions('settings.read')
  async list(@Query() query: PaginationQueryDto) {
    const page = query.page ?? 1,
      limit = Math.min(query.limit ?? 20, 100);
    const data = await this.db.query(
      'SELECT a.*, u.full_name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC, a.id DESC LIMIT $1 OFFSET $2',
      [limit, (page - 1) * limit],
    );
    const [count] = await this.db.query(
      'SELECT count(*)::int AS total FROM audit_events',
    );
    return {
      data: data.map((event: { method: string; route: string }) => ({
        ...event,
        action: actionLabel(event.method, event.route),
      })),
      meta: {
        page,
        limit,
        total: count.total,
        totalPages: Math.ceil(count.total / limit),
      },
    };
  }
}
