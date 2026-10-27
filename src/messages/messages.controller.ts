import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { CreateMessageDto, MessageListQueryDto } from './dto/message.dto';
import { MessagesService } from './messages.service';

@Controller('messages')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('messages.read')
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query() query: MessageListQueryDto,
  ) {
    return this.messagesService.findAll(user.sub, query);
  }

  @Get('unread-count')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('messages.read')
  unreadCount(@CurrentUser() user: JwtPayload) {
    return this.messagesService.unreadCount(user.sub);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('messages.read')
  findOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.messagesService.findOne(user.sub, id);
  }

  @Post()
  @RequirePermissions('messages.write')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateMessageDto) {
    return this.messagesService.create(user.sub, dto);
  }

  @Patch('read-all')
  @RequirePermissions('messages.read')
  markAllRead(@CurrentUser() user: JwtPayload) {
    return this.messagesService.markAllRead(user.sub);
  }

  @Patch(':id/read')
  @RequirePermissions('messages.read')
  markRead(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.messagesService.markRead(user.sub, id);
  }

  @Delete(':id')
  @RequirePermissions('messages.read')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.messagesService.remove(user.sub, id);
  }
}
