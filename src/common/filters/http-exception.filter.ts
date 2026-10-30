import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();
    const requestId =
      (typeof request.id === 'string' && request.id) ||
      (request.headers['x-request-id'] as string | undefined) ||
      undefined;

    if (
      (exception as { driverError?: { constraint?: string } })?.driverError
        ?.constraint === 'stock_unit_precision'
    ) {
      response.status(400).json({
        statusCode: 400,
        message:
          'Quantity must match the item stock unit precision. Whole units cannot have fractional quantities.',
        requestId,
      });
      return;
    }
    if (
      (exception as { driverError?: { constraint?: string } })?.driverError
        ?.constraint === 'item_stock_unit_locked'
    ) {
      response.status(400).json({
        statusCode: 400,
        message:
          'Stock unit is protected by inventory history or related documents. Configure an alternative unit conversion instead.',
        requestId,
      });
      return;
    }
    if (
      (exception as { driverError?: { constraint?: string } })?.driverError
        ?.constraint === 'item_unit_conversions_exist'
    ) {
      response.status(400).json({
        statusCode: 400,
        message:
          'Remove alternative unit settings before correcting an unused item stock unit.',
        requestId,
      });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const logMessage = typeof body === 'string' ? body : JSON.stringify(body);
      const reqLabel = `${request.method} ${request.url}`;
      const idPart = requestId ? ` reqId=${requestId}` : '';

      if (status >= 500) {
        this.logger.error(
          `${reqLabel} ${status}${idPart} ${logMessage}`,
          exception.stack,
        );
      } else {
        this.logger.warn(`${reqLabel} ${status}${idPart} ${logMessage}`);
      }

      const payload =
        typeof body === 'string'
          ? { statusCode: status, message: body }
          : { ...body };

      response.status(status).json({
        ...payload,
        ...(requestId ? { requestId } : {}),
      });
      return;
    }

    this.logger.error(
      `${request.method} ${request.url}${requestId ? ` reqId=${requestId}` : ''}`,
      exception instanceof Error ? exception.stack : exception,
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      ...(requestId ? { requestId } : {}),
    });
  }
}
