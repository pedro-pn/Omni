FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/chamada-poc . \
    && mkdir -p /out/data \
    && chown 65532:65532 /out/data \
    && chmod 700 /out/data

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/chamada-poc /chamada-poc
COPY --from=build --chown=65532:65532 /out/data /data
USER 65532:65532
ENV CHAMADA_DADOS=/data
ENTRYPOINT ["/chamada-poc"]
