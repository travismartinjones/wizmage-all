//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by Travis Jones on 1/22/26.
//

import SafariServices
import Vision
import ImageIO
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        if let request = message as? [String: Any],
           request["command"] as? String == "classifyLocalImage",
           let base64 = request["base64"] as? String {
            os_log(.default, "Received local image classification request (profile: %@)", profile?.uuidString ?? "none")
            DispatchQueue.global(qos: .userInitiated).async {
                self.complete(context, with: self.classifyLocalImage(base64))
            }
            return
        }

        os_log(.default, "Received native extension message (profile: %@)", profile?.uuidString ?? "none")

        complete(context, with: [ "echo": message as Any ])
    }

    private func complete(_ context: NSExtensionContext, with payload: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [ SFExtensionMessageKey: payload ]
        } else {
            response.userInfo = [ "message": payload ]
        }

        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }

    private func classifyLocalImage(_ base64: String) -> [String: Any] {
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return [ "ok": false ]
        }

        let faceRequest = VNDetectFaceRectanglesRequest()
        var containsPerson = false
        var personConfidence: Float = 0

        do {
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            if #available(iOS 13.0, macOS 10.15, *) {
                let humanRequest = VNDetectHumanRectanglesRequest()
                let classificationRequest = VNClassifyImageRequest()
                try handler.perform([faceRequest, humanRequest, classificationRequest])

                let personLabels: Set<String> = [
                    "people", "person", "human", "adult", "teen", "child", "baby",
                    "toddler", "crowd", "portrait", "selfie", "face"
                ]
                for observation in classificationRequest.results ?? [] {
                    if personLabels.contains(observation.identifier.lowercased()) {
                        personConfidence = max(personConfidence, observation.confidence)
                    }
                }

                containsPerson = !(faceRequest.results ?? []).isEmpty
                    || !(humanRequest.results ?? []).isEmpty
                    || personConfidence >= 0.12
            } else {
                try handler.perform([faceRequest])
                containsPerson = !(faceRequest.results ?? []).isEmpty
            }
        } catch {
            os_log(.error, "Local image classification failed: %@", error.localizedDescription)
            return [ "ok": false ]
        }

        return [
            "ok": true,
            "containsPerson": containsPerson,
            "personConfidence": Double(personConfidence)
        ]
    }

}
