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
